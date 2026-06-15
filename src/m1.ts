import Anthropic from "@anthropic-ai/sdk"
import { execSync } from "node:child_process"

// ── Provider：智谱 GLM 的 Anthropic 兼容端点 ──
// bigmodel.cn 国内直连；apiKey 复用 shell 里现成的 ANTHROPIC_AUTH_TOKEN（即智谱 key）
const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"

// ① 工具定义：用 JSON Schema 告诉模型「你有一个 bash 可以调」
//    description 写得越清楚，模型越知道什么时候该用它。
const tools: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "在用户的 macOS 终端执行一条 bash 命令并返回输出。用来查看文件、运行命令、完成任务。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的 bash 命令" } },
      required: ["command"],
    },
  },
]

// ② 工具的真实执行体。模型只会「请求」调用，真正跑命令的是我们这边的代码。
function runBash(command: string): string {
  try {
    return execSync(command, { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }) || "(无输出)"
  } catch (e: any) {
    // 出错也要把报错返回给模型 —— 让它自己看到错误、自己决定怎么补救。这就是 agent 的自愈能力。
    return `[命令失败] ${e.stderr || e.message}`
  }
}

// ③ Agent Loop —— 整个 Claude Code 的内核，就是下面这个 while 循环。
const task = process.argv.slice(2).join(" ") || "列出当前目录下最大的 3 个文件，并推测这个项目大概是干嘛的"
const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

console.log(`任务：${task}\n`)
let turn = 0
while (true) {
  if (++turn > 20) { console.log("\n[熔断] 超过 20 轮，强制停止"); break }
  console.log(`—— 第 ${turn} 轮 → 问模型 ——`)

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: "你是跑在用户 macOS 终端里的编码 agent。需要信息或要干活时就调用 bash 工具，一步步把任务做完；完成后用中文简短总结。",
    tools,
    messages,
  })

  // 把模型这一轮的完整输出（文字 + 可能的工具调用）原样追加进历史 —— 一个 block 都不能漏。
  messages.push({ role: "assistant", content: res.content })
  for (const b of res.content) {
    if (b.type === "text" && b.text.trim()) console.log(`模型｜${b.text}`)
  }

  // 模型不再要求调工具（end_turn）→ 任务结束，跳出循环。
  if (res.stop_reason !== "tool_use") {
    console.log(`\n[完成] stop_reason=${res.stop_reason}`)
    break
  }

  // 执行模型请求的每个工具调用，把结果回填成一条 user 消息，再进下一轮。
  const results: Anthropic.ToolResultBlockParam[] = []
  for (const b of res.content) {
    if (b.type === "tool_use") {
      const { command } = b.input as { command: string }
      console.log(`执行｜bash: ${command}`)
      const out = runBash(command)
      console.log(out.length > 600 ? out.slice(0, 600) + " …(截断)" : out)
      results.push({ type: "tool_result", tool_use_id: b.id, content: out })
    }
  }
  messages.push({ role: "user", content: results })
}
