import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline"
import { join } from "node:path"
import { tools as builtinTools, type Tool } from "./tools"
import { MCPClient } from "./mcp"
import { runAgent } from "./agent"
import { makeTaskTool } from "./task"

// M7 = M6(权限门 + 压缩 + 缓存 + 可中断 + MCP) + 子 agent。
// 最大变化：m0-m6 的 inline while loop 被抽进 src/agent.ts 的 runAgent()，
// 于是 m7 退化成一个「壳」——只负责①准备工具表 ②搭交互层(键盘中断 / y-n 审批)，
// 把它们当回调注入 runAgent。抽出来的直接回报：task 工具(src/task.ts)能在自己的
// execute 里再调一次 runAgent，跑一个带【独立上下文】的子 agent。主 / 子 共用同一内核。

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"

const SYSTEM: Anthropic.TextBlockParam[] = [{
  type: "text",
  text:
    "你是跑在用户 macOS 终端里的编码 agent。优先用专门工具(read_file/write_file/edit_file/glob/grep)读写改代码，少用 bash；改动现有文件时用 edit_file 做最小精确修改。" +
    "遇到「需要读很多文件才能回答」的调研型子任务(例如搞清某目录下每个文件分别干嘛)，优先用 task 工具派给子 agent —— 它带独立上下文、只把结论回传，能省下你的窗口。" +
    "需要算术时可用 mcp__calc__* 工具。完成后用中文简短总结。",
  cache_control: { type: "ephemeral" },
}]

const task =
  process.argv.slice(2).join(" ") ||
  "用 task 工具调研 src/ 下每个 .ts 文件分别实现了哪个里程碑(M几)，最后汇总成一个清单。"

// —— 连 MCP(同 m6)：失败则降级为只用内置工具 ——
const mcp = new MCPClient(["bun", "run", join(import.meta.dir, "../demo/mcp-server-calc.ts")])
let mcpTools: Tool[] = []
try {
  await mcp.connect()
  mcpTools = mcp.toTools("calc")
  console.log(`✅ MCP 已连接 calc server，导入工具：${mcpTools.map((t) => t.name).join(", ")}`)
} catch (e: any) {
  console.error(`⚠️ MCP 连接失败，降级为只用内置工具：${e.message}`)
}

// —— 工具表：内置 + MCP + task ——
// 顺序很关键：先用「不含 task」的 baseTools 造 task 工具(它派给子 agent 的 parentTools 快照)，
// 再把 task 追加进主工具表 allTools。这样子 agent 的候选里天然没有 task
// (叠加 selectSubagentTools 的 name!=="task"，双保险防递归)。
const baseTools = [...builtinTools, ...mcpTools]
const taskTool = makeTaskTool({ client, model: MODEL, parentTools: baseTools })
const allTools = [...baseTools, taskTool]

const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

// —— 中断 + 审批：交互层留在壳里，通过回调注入 runAgent(键盘监听同 m6) ——
const ac = new AbortController()
let approvalResolver: ((key: string) => void) | null = null
readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on("keypress", (str, key) => {
  if (approvalResolver) { approvalResolver((str || key?.name || "").toLowerCase()); return }
  if (key?.ctrl && key?.name === "c") { console.log("\n[Ctrl+C] 退出"); process.exit(0) }
  if (key?.name === "escape") { console.log("\n[Esc] 打断当前操作…"); ac.abort() }
})

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

console.log(`任务：${task}\n可用工具：${allTools.map((t) => t.name).join(", ")}\n(只读工具 / task 自动放行；写操作 / MCP 工具需按 y；危险命令直接拦；Esc 打断，Ctrl+C 退出)\n`)

// —— m6 的 inline while loop → 一次 runAgent 调用。交互细节全走注入的回调 ——
const result = await runAgent({
  client,
  model: MODEL,
  system: SYSTEM,
  tools: allTools,
  messages,
  approve: (tool, _input, brief) => askApproval(`❓ 允许执行 ${tool.name} ${brief}？(y=允许 / 其他=拒绝) `),
  onText: (d) => process.stdout.write(d),
  signal: ac.signal,
  label: "main",
  verbose: true,
})

if (result.aborted) console.log("\n[已中断]")
const total = result.usage.fresh + result.usage.cached
const pct = total ? ((result.usage.cached / total) * 100).toFixed(1) : "0"
console.log(`\n[账单] 累计新 input=${result.usage.fresh}　cache 命中=${result.usage.cached}　命中率=${pct}%（共 ${result.turns} 轮，stop=${result.stopReason}）`)
await mcp.close().catch(() => {}) // 优雅关闭 MCP server 子进程
process.exit(0)
