// D8 eval harness —— 批量跑任务、统计通过率/轮数/token，并演示一个 LLM-judge。
//
// 这是 D7 抽出的 runAgent 的【第二次复用】：eval 要"批量跑 N 个 agent 并聚合指标"，
// 正好就是 runAgent(可注入 client + 返回 turns/usage)的用武之地——继 task 之后再证一次抽对了。
//
// 跑法：AUTO_APPROVE 无关(这里直接传 approve:()=>true)。真 LLM + 连 calc MCP。
//   bun run demo/eval.ts            # 简洁报告
//   EVAL_VERBOSE=1 bun run demo/eval.ts   # 打印每个任务的过程

import Anthropic from "@anthropic-ai/sdk"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { tools as builtinTools, type Tool } from "../src/tools"
import { MCPClient } from "../src/mcp"
import { runAgent } from "../src/agent"
import { makeTaskTool } from "../src/task"
import { tasks } from "./eval-tasks"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"
const VERBOSE = process.env.EVAL_VERBOSE === "1"

const SYSTEM =
  "你是跑在用户 macOS 终端里的编码 agent。优先用专门工具(read_file/write_file/edit_file/glob/grep)读写改代码；" +
  "需要算术时用 mcp__calc__* 工具；需要读很多文件的调研型子任务用 task 派子 agent。完成后用一句话给出最终结果。"

// —— 连 MCP + 组工具表(同 m7) ——
const mcp = new MCPClient(["bun", "run", join(import.meta.dir, "mcp-server-calc.ts")])
let mcpTools: Tool[] = []
try {
  await mcp.connect()
  mcpTools = mcp.toTools("calc")
} catch (e: any) {
  console.error(`⚠️ MCP 连接失败，T4 可能不过：${e.message}`)
}
const baseTools = [...builtinTools, ...mcpTools]
const taskTool = makeTaskTool({ client, model: MODEL, parentTools: baseTools })
const allTools = [...baseTools, taskTool]

// —— LLM-as-judge：裸 LLM(不带工具)按 rubric 给产出打 1-5 分 ——
// 与程序化断言对照：程序化只判「有没有达成」，judge 能判「质量好不好」(代价是慢/贵/judge 也会错)。
async function judge(taskDesc: string, artifact: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: "你是严格的代码评审。按 rubric 给被评内容打 1-5 分(5 最好)，只输出一行：`分数/5 — 一句理由`。",
      messages: [{
        role: "user",
        content: `任务：${taskDesc}\n\n被评产出：\n\`\`\`\n${artifact}\n\`\`\`\n\nrubric：① 是否正确实现 ② 有无类型标注 ③ 可读性。给分：`,
      }],
    })
    return (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim()
  } catch (e: any) {
    return `(judge 调用失败：${e.message})`
  }
}

console.log(`\n=== mini-cc eval · ${tasks.length} 个任务 ===\n`)
const rows: { name: string; pass: boolean; detail: string; turns: number; tokens: number }[] = []

for (const task of tasks) {
  task.setup?.()
  const result = await runAgent({
    client,
    model: MODEL,
    system: SYSTEM,
    tools: allTools,
    messages: [{ role: "user", content: task.prompt }], // 每任务独立 messages，互不污染
    approve: () => true,
    maxTurns: 12,
    label: task.name,
    verbose: VERBOSE,
  })
  const verdict = task.check(result.text)
  const tokens = result.usage.fresh + result.usage.cached
  rows.push({ name: task.name, pass: verdict.pass, detail: verdict.detail, turns: result.turns, tokens })
  console.log(`${verdict.pass ? "✅" : "❌"} ${task.name.padEnd(10)} ${String(result.turns).padStart(2)} 轮 · ${String(tokens).padStart(6)} tok　${verdict.detail}`)

  // T1 额外用 LLM-judge 评代码质量，和上面的程序化断言对照
  if (task.name === "T1-write") {
    let code = ""
    try { code = readFileSync(join(task.dir, "greet.ts"), "utf8") } catch {}
    if (code) {
      const score = await judge("写一个 greet(name) 返回 'Hello, '+name 的 TS 函数", code)
      console.log(`   🧑‍⚖️ LLM-judge(评质量,程序化只判有没有)：${score}`)
    }
  }
}

// —— 报告：通过率 + 平均轮数 + 总 token(最朴素的成本可观测) ——
const passed = rows.filter((r) => r.pass).length
const avgTurns = (rows.reduce((s, r) => s + r.turns, 0) / rows.length).toFixed(1)
const totalTok = rows.reduce((s, r) => s + r.tokens, 0)
console.log(`\n=== 报告 ===`)
console.log(`通过率 ${passed}/${rows.length}　·　平均轮数 ${avgTurns}　·　总 token ${totalTok}`)

await mcp.close().catch(() => {})
process.exit(passed === rows.length ? 0 : 1)
