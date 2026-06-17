import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline"
import { tools, toolMap } from "./tools"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"
const SYSTEM =
  "你是跑在用户 macOS 终端里的编码 agent。优先用专门工具(read_file/write_file/edit_file/glob/grep)读写改代码，少用 bash；改动现有文件时用 edit_file 做最小精确修改。完成后用中文简短总结。"

const toolSchemas: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

const task =
  process.argv.slice(2).join(" ") ||
  "先用两三句话简短介绍你能做什么，再用 bash 执行 date 看看现在几点。"
const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

// —— 中断监听：Esc 打断「当前这一轮」操作；Ctrl+C 直接退出整个程序 ——
// ac 每轮换新的（见循环里）。keypress 回调里 abort 的永远是「当下这把」。
let ac = new AbortController()
readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true) // 进 raw 模式才能逐键捕获 Esc
process.stdin.on("keypress", (_str, key) => {
  if (key?.ctrl && key?.name === "c") { console.log("\n[Ctrl+C] 退出"); process.exit(0) }
  if (key?.name === "escape") { console.log("\n[Esc] 打断当前操作…"); ac.abort() }
})

console.log(`任务：${task}\n可用工具：${tools.map((t) => t.name).join(", ")}\n(模型生成中或工具执行中按 Esc 打断，Ctrl+C 退出)\n`)

let turn = 0
while (true) {
  if (++turn > 25) { console.log("\n[熔断] 超过 25 轮"); break }
  ac = new AbortController() // 每轮一把新「中断锁」
  console.log(`—— 第 ${turn} 轮 ——`)

  // ① 流式请求：把 signal 交给 stream → Esc 能掐断正在传输的 HTTP 流
  const stream = client.messages.stream(
    { model: MODEL, max_tokens: 2048, system: SYSTEM, tools: toolSchemas, messages },
    { signal: ac.signal },
  )
  // ② 边生成边吐字：只打印 text 增量（tool_use 的参数等攒齐后再统一打印）
  stream.on("text", (delta) => process.stdout.write(delta))

  // ③ finalMessage()：把一地碎片（text_delta + tool_use 的 input_json_delta）重新拼成
  //    一条完整 message —— 这正是 agent loop 需要塞回 messages 的东西。
  let res: Anthropic.Message
  try {
    res = await stream.finalMessage()
  } catch (e: any) {
    if (ac.signal.aborted) { console.log("\n[已中断] 模型生成被打断"); break }
    throw e
  }
  process.stdout.write("\n")

  messages.push({ role: "assistant", content: res.content })
  if (res.stop_reason !== "tool_use") { console.log(`\n[完成] stop_reason=${res.stop_reason}`); break }

  // ④ 执行工具：同一把 signal 传进 execute → bash 长命令也能被 Esc 杀掉子进程
  const results: Anthropic.ToolResultBlockParam[] = []
  for (const b of res.content) {
    if (b.type === "tool_use") {
      const tool = toolMap.get(b.name)
      console.log(`执行｜${b.name} ${JSON.stringify(b.input).slice(0, 140)}`)
      const out = tool ? await tool.execute(b.input, ac.signal) : `[未知工具] ${b.name}`
      console.log(out.length > 300 ? out.slice(0, 300) + " …(截断)" : out)
      results.push({ type: "tool_result", tool_use_id: b.id, content: out })
    }
  }
  // ⑤ 工具阶段被 Esc → 干净收场，不把半截结果喂回模型
  if (ac.signal.aborted) { console.log("\n[已中断] 工具执行被打断"); break }
  messages.push({ role: "user", content: results })
}
process.exit(0) // raw 模式下 stdin 会挂住进程，主动退出
