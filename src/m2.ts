import Anthropic from "@anthropic-ai/sdk"
import { tools, toolMap } from "./tools"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"

// 从注册表抽出每个工具的「说明书」发给模型（execute 不发——模型只需知道有啥、怎么调）
const toolSchemas: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

const task =
  process.argv.slice(2).join(" ") ||
  "在 demo/ 目录下创建 hello.ts，里面写一个打印 Hello 的函数；然后把其中的 Hello 改成 Hi；最后读出文件确认。"
const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

console.log(`任务：${task}\n可用工具：${tools.map((t) => t.name).join(", ")}\n`)
let turn = 0
while (true) {
  if (++turn > 25) { console.log("\n[熔断] 超过 25 轮"); break }
  console.log(`—— 第 ${turn} 轮 ——`)

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system:
      "你是跑在用户 macOS 终端里的编码 agent。优先用专门工具(read_file/write_file/edit_file/glob/grep)读写改代码，少用 bash；改动现有文件时用 edit_file 做最小精确修改。完成后用中文简短总结。",
    tools: toolSchemas,
    messages,
  })
  messages.push({ role: "assistant", content: res.content })
  for (const b of res.content) {
    if (b.type === "text" && b.text.trim()) console.log(`模型｜${b.text}`)
  }
  if (res.stop_reason !== "tool_use") { console.log(`\n[完成] stop_reason=${res.stop_reason}`); break }

  // ★ 关键：loop 不认识任何具体工具，只按 name 去注册表查、调 execute。
  // 加再多工具，这段都不用动 —— 这就是工具系统抽象的意义。
  const results: Anthropic.ToolResultBlockParam[] = []
  for (const b of res.content) {
    if (b.type === "tool_use") {
      const tool = toolMap.get(b.name)
      console.log(`执行｜${b.name} ${JSON.stringify(b.input).slice(0, 140)}`)
      const out = tool ? await tool.execute(b.input) : `[未知工具] ${b.name}`
      console.log(out.length > 300 ? out.slice(0, 300) + " …(截断)" : out)
      results.push({ type: "tool_result", tool_use_id: b.id, content: out })
    }
  }
  messages.push({ role: "user", content: results })
}
