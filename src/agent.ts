import type Anthropic from "@anthropic-ai/sdk"
import type { Tool } from "./tools"
import { checkPermission } from "./permission"
import { compact, estimateTokens } from "./compact"

// ============================================================================
// D7 的核心抽象：runAgent —— 一个可复用、可嵌套、可注入 client 的 agent loop。
//
// m0-m6 每个都是「顶层 while 脚本」，loop 内核和外壳(readline 中断 / 账单打印 /
// 交互审批)缠在一起，没法被第二次调用。子 agent 的本质是「在工具调用里再跑一遍
// 完整的 loop」—— 所以必须先把内核抽出来，主 agent(m7 壳) 和子 agent(task 工具)
// 共用同一个它。真 CC 亦然：AgentTool 调的就是和主对话同源的 runAgent。
//
// 抽象的关键 = 把外壳依赖「参数化」掉：
//   - approve：有副作用工具要不要放行，外包给调用方(主=交互 y/n，子=恒 true)
//   - onText ：流式 token 往哪儿写，外包给调用方(主=stdout，子=不接)
//   - signal ：中断信号由调用方持有(主 Esc / 子继承主的 signal)
//   - verbose：是否打印过程日志(主=true 看得见，子=true 但带 [sub] 前缀，证明隔离)
// 内核自己只管：流式取回复 → 权限门 → 执行工具 → 回填 → 压缩 → 循环。不碰
// readline、不碰 process.exit —— 这才是「纯」到能被嵌套调用的 loop。
// ============================================================================

const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD) || 20000

// 滚动缓存(从 m6 平移)：给「发送副本」的最后一个 block 打 cache 断点，不污染原 messages。
// 于是缓存「tools + system + 到这一刻为止的全部历史」，下一轮前缀字节一致即命中。
function withRollingCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!messages.length) return messages
  const out = messages.slice()
  const last = out[out.length - 1]!
  const content =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : last.content.slice()
  content[content.length - 1] = {
    ...(content[content.length - 1] as any),
    cache_control: { type: "ephemeral" },
  }
  out[out.length - 1] = { ...last, content: content as any }
  return out
}

// 权限决策回调：runAgent 把「要不要放行这次有副作用的工具」外包给调用方。
// 主 agent 注入交互式 y/n；子 agent 注入恒 true(其工具集只读，本就不会触发 ask)。
export type ApproveFn = (tool: Tool, input: any, brief: string) => boolean | Promise<boolean>

export interface RunAgentOptions {
  client: Anthropic // 注入 → 可传 fake client 做纯单元测
  model: string
  system: string | Anthropic.TextBlockParam[]
  tools: Tool[]
  messages: Anthropic.MessageParam[] // 调用方拥有；runAgent 原地推进(压缩时换引用)
  approve: ApproveFn
  onText?: (delta: string) => void // 流式回调；不传则静默
  signal?: AbortSignal
  maxTurns?: number
  label?: string // 日志前缀，区分 main / sub
  verbose?: boolean // 是否打印过程日志
}

export interface RunAgentResult {
  text: string // 末条 assistant 的 text 拼接 = agent 的「最终汇报」
  usage: { fresh: number; cached: number }
  turns: number
  stopReason: string | null
  aborted: boolean
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { client, model, system, tools, approve, onText, signal } = opts
  const maxTurns = opts.maxTurns ?? 25
  const label = opts.label ?? "agent"
  const log = opts.verbose ? (...a: any[]) => console.log(`[${label}]`, ...a) : () => {}
  let messages = opts.messages

  // toolMap / toolSchemas 由传入的 tools 现建 —— 同一个内核，主给全量工具、子给只读子集。
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  const toolSchemas: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))

  let turn = 0
  let fresh = 0,
    cached = 0
  let stopReason: string | null = null
  let last: Anthropic.Message | null = null

  while (true) {
    if (signal?.aborted) return done(true)
    if (++turn > maxTurns) {
      stopReason = "max_turns"
      log(`[熔断] 超过 ${maxTurns} 轮`)
      break
    }
    log(`—— 第 ${turn} 轮 ——`)

    const stream = client.messages.stream(
      { model, max_tokens: 2048, system, tools: toolSchemas, messages: withRollingCache(messages) },
      { signal },
    )
    if (onText) stream.on("text", (d: string) => onText(d))

    try {
      last = await stream.finalMessage()
    } catch (e: any) {
      if (signal?.aborted) return done(true)
      throw e
    }
    onText?.("\n")

    const u = last.usage as any
    fresh += u?.input_tokens ?? 0
    cached += u?.cache_read_input_tokens ?? 0
    log(`[usage] 新 input=${u?.input_tokens ?? 0}　cache 命中=${u?.cache_read_input_tokens ?? 0}　output=${u?.output_tokens ?? 0}`)

    messages.push({ role: "assistant", content: last.content })
    stopReason = last.stop_reason
    if (last.stop_reason !== "tool_use") break

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const b of last.content) {
      if (b.type !== "tool_use") continue
      const tool = toolMap.get(b.name)
      const brief = JSON.stringify(b.input).slice(0, 120)
      if (!tool) {
        log(`[未知工具] ${b.name}`)
        results.push({ type: "tool_result", tool_use_id: b.id, content: `[未知工具] ${b.name}`, is_error: true })
        continue
      }

      // 权限门(同 m5/m6)：MCP / 写工具 readOnly=false → ask；危险 bash → deny；只读 → allow。
      // 子 agent 的工具集是只读子集 → 永远 allow，approve 不会被调到。
      const decision = checkPermission(tool, b.input)
      if (decision === "deny") {
        log(`🛑 拒绝｜${b.name} ${brief}（命中危险策略）`)
        results.push({ type: "tool_result", tool_use_id: b.id, content: `[权限拒绝] ${b.name} 命中危险命令策略，未执行。请换一个更安全的做法。`, is_error: true })
        continue
      }
      if (decision === "ask") {
        const ok = await approve(tool, b.input, brief)
        if (!ok) {
          results.push({ type: "tool_result", tool_use_id: b.id, content: `[用户拒绝] 用户拒绝了 ${b.name}。请改用别的方式或先询问用户。`, is_error: true })
          continue
        }
      }

      log(`执行｜${b.name} ${brief}`)
      const out = await tool.execute(b.input, signal)
      log(out.length > 300 ? out.slice(0, 300) + " …(截断)" : out)
      results.push({ type: "tool_result", tool_use_id: b.id, content: out })
    }
    if (signal?.aborted) return done(true)
    messages.push({ role: "user", content: results })

    // 对话太长就压缩老历史(同 m4/m6)。压缩换 messages 引用 —— 主子各自的历史互不相干。
    const est = estimateTokens(messages)
    if (est > COMPACT_THRESHOLD) {
      log(`[压缩] 估算 ${est} token 超阈值，压缩老历史…`)
      messages = await compact(client, model, messages)
    }
  }

  return done(false)

  function done(aborted: boolean): RunAgentResult {
    return { text: lastText(last), usage: { fresh, cached }, turns: turn, stopReason, aborted }
  }
}

// 取末条 assistant 的全部 text block 拼接 = agent 的「最终汇报」。
// 对应 cc-haha finalizeAgentTool(agentToolUtils.ts:276) 取 last assistant text blocks。
function lastText(msg: Anthropic.Message | null): string {
  if (!msg) return ""
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
}
