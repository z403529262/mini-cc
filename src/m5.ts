import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline"
import { tools, toolMap } from "./tools"
import { compact, estimateTokens } from "./compact"
import { checkPermission } from "./permission"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD) || 20000

const SYSTEM: Anthropic.TextBlockParam[] = [{
  type: "text",
  text: "你是跑在用户 macOS 终端里的编码 agent。优先用专门工具(read_file/write_file/edit_file/glob/grep)读写改代码，少用 bash；改动现有文件时用 edit_file 做最小精确修改。完成后用中文简短总结。",
  cache_control: { type: "ephemeral" },
}]

const toolSchemas: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

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

const task =
  process.argv.slice(2).join(" ") ||
  "在 demo/scratch/ 下创建 calc.ts，写一个加法函数；再把加法改成减法；最后读出文件确认。"
let messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

// —— 中断 + 审批，共用 raw 模式下的同一个 keypress 监听 ——
// approvalResolver 有值 = 正在等用户对某次工具调用回答 y/n，此时按键交给审批；
// 否则按键走 Esc(打断当前轮) / Ctrl+C(退出)。
let ac = new AbortController()
let approvalResolver: ((key: string) => void) | null = null
readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on("keypress", (str, key) => {
  if (approvalResolver) { approvalResolver((str || key?.name || "").toLowerCase()); return }
  if (key?.ctrl && key?.name === "c") { console.log("\n[Ctrl+C] 退出"); process.exit(0) }
  if (key?.name === "escape") { console.log("\n[Esc] 打断当前操作…"); ac.abort() }
})

// M5 审批：raw 模式下单键即答 —— 按 y 允许，其余键一律拒绝。
function askApproval(prompt: string): Promise<boolean> {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    approvalResolver = (k) => {
      approvalResolver = null
      const yes = k === "y"
      console.log(yes ? "y ✓" : `${k || "?"} ✗`)
      resolve(yes)
    }
  })
}

console.log(`任务：${task}\n可用工具：${tools.map((t) => t.name).join(", ")}\n(只读工具自动放行；写操作需按 y 确认；危险命令直接拦；Esc 打断，Ctrl+C 退出)\n`)

let turn = 0
let totalFresh = 0, totalCached = 0
while (true) {
  if (++turn > 25) { console.log("\n[熔断] 超过 25 轮"); break }
  ac = new AbortController()
  console.log(`—— 第 ${turn} 轮 ——`)

  const stream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: toolSchemas,
      messages: withRollingCache(messages),
    },
    { signal: ac.signal },
  )
  stream.on("text", (d) => process.stdout.write(d))

  let res: Anthropic.Message
  try { res = await stream.finalMessage() }
  catch (e: any) { if (ac.signal.aborted) { console.log("\n[已中断] 模型生成被打断"); break } throw e }
  process.stdout.write("\n")

  const u = res.usage as any
  const fresh = u.input_tokens ?? 0
  const cached = u.cache_read_input_tokens ?? 0
  totalFresh += fresh; totalCached += cached
  console.log(`[usage] 新 input=${fresh}　cache 命中=${cached}　output=${u.output_tokens}`)

  messages.push({ role: "assistant", content: res.content })
  if (res.stop_reason !== "tool_use") { console.log(`\n[完成] stop_reason=${res.stop_reason}`); break }

  const results: Anthropic.ToolResultBlockParam[] = []
  for (const b of res.content) {
    if (b.type !== "tool_use") continue
    const tool = toolMap.get(b.name)
    const brief = JSON.stringify(b.input).slice(0, 120)
    if (!tool) {
      results.push({ type: "tool_result", tool_use_id: b.id, content: `[未知工具] ${b.name}`, is_error: true })
      continue
    }

    // ★ M5 权限门：在 execute【之前】判定。拒绝/未批 → 根本不执行，回填 is_error 让模型换方案。
    const decision = checkPermission(tool, b.input)
    if (decision === "deny") {
      console.log(`🛑 拒绝｜${b.name} ${brief}（命中危险策略）`)
      results.push({ type: "tool_result", tool_use_id: b.id, content: `[权限拒绝] ${b.name} 命中危险命令策略，未执行。请换一个更安全的做法。`, is_error: true })
      continue
    }
    if (decision === "ask") {
      const ok = await askApproval(`❓ 允许执行 ${b.name} ${brief}？(y=允许 / 其他=拒绝) `)
      if (!ok) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: `[用户拒绝] 用户拒绝了 ${b.name}。请改用别的方式或先询问用户。`, is_error: true })
        continue
      }
    }

    // allow / 已批准 → 才真正执行
    console.log(`执行｜${b.name} ${brief}`)
    const out = await tool.execute(b.input, ac.signal)
    console.log(out.length > 300 ? out.slice(0, 300) + " …(截断)" : out)
    results.push({ type: "tool_result", tool_use_id: b.id, content: out })
  }
  if (ac.signal.aborted) { console.log("\n[已中断] 工具执行被打断"); break }
  messages.push({ role: "user", content: results })

  const est = estimateTokens(messages)
  if (est > COMPACT_THRESHOLD) {
    console.log(`\n[压缩] 估算 ${est} token 超阈值 ${COMPACT_THRESHOLD}，压缩老历史…`)
    const before = messages.length
    messages = await compact(client, MODEL, messages)
    console.log(`[压缩] ${before} 条 → ${messages.length} 条，现估算 ${estimateTokens(messages)} token`)
  }
}

const total = totalFresh + totalCached
const pct = total ? ((totalCached / total) * 100).toFixed(1) : "0"
console.log(`\n[账单] 累计新 input=${totalFresh}　cache 命中=${totalCached}　命中率=${pct}%`)
process.exit(0)
