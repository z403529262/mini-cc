import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline"
import { join } from "node:path"
import { tools as builtinTools, type Tool } from "./tools"
import { compact, estimateTokens } from "./compact"
import { checkPermission } from "./permission"
import { MCPClient } from "./mcp"

// M6 = M5(权限门 + 压缩 + 缓存 + 可中断) + 接入 MCP 外部工具。
// 全片相对 m5 只多三处：①loop 前连 MCP、合并工具表 ②开场提示带上 MCP 工具 ③收尾 close。
// loop 主体逐字未动 —— 这正是 D6 要证明的：工具来自内置还是 MCP，对 agent loop 完全透明。

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD) || 20000

const SYSTEM: Anthropic.TextBlockParam[] = [{
  type: "text",
  text: "你是跑在用户 macOS 终端里的编码 agent。优先用专门工具(read_file/write_file/edit_file/glob/grep)读写改代码，少用 bash；改动现有文件时用 edit_file 做最小精确修改。需要算术时可用 mcp__calc__* 工具。完成后用中文简短总结。",
  cache_control: { type: "ephemeral" },
}]

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
  "用 calc 工具算 (2+3)*4 等于多少，分两步算并说出过程。"

// —— M6 核心：启动时连 MCP server，把它暴露的工具并进本地工具表 ——
// toolMap / toolSchemas 依赖「内置 + MCP」合并后的结果，所以必须放在 connect 之后再构建。
const mcp = new MCPClient(["bun", "run", join(import.meta.dir, "../demo/mcp-server-calc.ts")])
let mcpTools: Tool[] = []
try {
  await mcp.connect()
  mcpTools = mcp.toTools("calc")
  console.log(`✅ MCP 已连接 calc server，导入工具：${mcpTools.map((t) => t.name).join(", ")}`)
} catch (e: any) {
  // 外部依赖故障不该拖垮 agent —— 降级为只用内置工具继续跑
  console.error(`⚠️ MCP 连接失败，降级为只用内置工具：${e.message}`)
}
const allTools = [...builtinTools, ...mcpTools]
const toolMap = new Map(allTools.map((t) => [t.name, t]))
const toolSchemas: Anthropic.Tool[] = allTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

let messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

// —— 中断 + 审批，共用 raw 模式下的同一个 keypress 监听（同 m5）——
let ac = new AbortController()
let approvalResolver: ((key: string) => void) | null = null
readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on("keypress", (str, key) => {
  if (approvalResolver) { approvalResolver((str || key?.name || "").toLowerCase()); return }
  if (key?.ctrl && key?.name === "c") { console.log("\n[Ctrl+C] 退出"); process.exit(0) }
  if (key?.name === "escape") { console.log("\n[Esc] 打断当前操作…"); ac.abort() }
})

// 非交互模式(CI / 演示)：AUTO_APPROVE=1 时所有 ask 自动放行 —— 真 CC 的 acceptEdits/dontAsk 模式雏形。
const AUTO_APPROVE = process.env.AUTO_APPROVE === "1"
function askApproval(prompt: string): Promise<boolean> {
  if (AUTO_APPROVE) { console.log(`${prompt}y ✓ (AUTO_APPROVE)`); return Promise.resolve(true) }
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

console.log(`任务：${task}\n可用工具：${allTools.map((t) => t.name).join(", ")}\n(只读工具自动放行；写操作 / MCP 工具需按 y 确认；危险命令直接拦；Esc 打断，Ctrl+C 退出)\n`)

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

    // ★ 权限门：MCP 工具 readOnly=false → 自然落到 ask 分支，与内置写工具同样对待（零特判）
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
await mcp.close().catch(() => {}) // 优雅关闭 MCP server 子进程
process.exit(0)
