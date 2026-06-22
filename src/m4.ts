import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline"
import { tools, toolMap } from "./tools"
import { compact, estimateTokens } from "./compact"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD) || 20000 // 估算 token 超此值就压缩老历史

// ① system 打 cache 断点。渲染顺序是 tools → system → messages，
//    所以这个断点缓存的前缀 = 全部 tools + system —— 每轮都字节不变、命中率最高的部分。
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

// ② 滚动缓存：每轮请求时给「当前最后一条 message」的最后一个 block 打 cache 断点，
//    于是缓存「tools + system + 到这一刻为止的全部历史」。下一轮前缀只要字节一致就命中。
//    关键：不污染原 messages（只在发送的副本上打），否则历史里 cache_control 越积越多、超 4 断点上限。
function withRollingCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!messages.length) return messages
  const out = messages.slice()
  const last = out[out.length - 1]!
  const content =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : last.content.slice()
  // 给最后一个 content block 挂上 cache_control（各类型 block 都支持这个元数据）
  content[content.length - 1] = {
    ...(content[content.length - 1] as any),
    cache_control: { type: "ephemeral" },
  }
  out[out.length - 1] = { ...last, content: content as any }
  return out
}

const task =
  process.argv.slice(2).join(" ") ||
  "在 demo/ 下创建 calc.ts，写一个加法函数；再把加法改成减法；最后读出文件确认。"
let messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

// 中断（同 m3）：Esc 打断当前轮，Ctrl+C 退出
let ac = new AbortController()
readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on("keypress", (_s, key) => {
  if (key?.ctrl && key?.name === "c") { console.log("\n[Ctrl+C] 退出"); process.exit(0) }
  if (key?.name === "escape") { console.log("\n[Esc] 打断当前操作…"); ac.abort() }
})

console.log(`任务：${task}\n可用工具：${tools.map((t) => t.name).join(", ")}\n(每轮打印 cache 命中；Esc 打断，Ctrl+C 退出)\n`)

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
      messages: withRollingCache(messages), // ③ 发送时才打滚动断点
    },
    { signal: ac.signal },
  )
  stream.on("text", (d) => process.stdout.write(d))

  let res: Anthropic.Message
  try { res = await stream.finalMessage() }
  catch (e: any) { if (ac.signal.aborted) { console.log("\n[已中断] 模型生成被打断"); break } throw e }
  process.stdout.write("\n")

  // ④ 直观看缓存：新 input vs 命中缓存。第 2 轮起 cache 命中应大幅上升。
  const u = res.usage as any
  const fresh = u.input_tokens ?? 0
  const cached = u.cache_read_input_tokens ?? 0
  totalFresh += fresh; totalCached += cached
  console.log(`[usage] 新 input=${fresh}　cache 命中=${cached}　output=${u.output_tokens}`)

  messages.push({ role: "assistant", content: res.content })
  if (res.stop_reason !== "tool_use") { console.log(`\n[完成] stop_reason=${res.stop_reason}`); break }

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
  if (ac.signal.aborted) { console.log("\n[已中断] 工具执行被打断"); break }
  messages.push({ role: "user", content: results })

  // ⑥ 对话太长就压缩老历史：token 阈值触发 → LLM 总结 → 替换（配对安全见 compact.ts）。
  //    代价：压缩改写了历史前缀，下一轮 cache 会全 miss（前缀变了）→ 重新积累。
  const est = estimateTokens(messages)
  if (est > COMPACT_THRESHOLD) {
    console.log(`\n[压缩] 估算 ${est} token 超阈值 ${COMPACT_THRESHOLD}，压缩老历史…`)
    const before = messages.length
    messages = await compact(client, MODEL, messages)
    console.log(`[压缩] ${before} 条 → ${messages.length} 条，现估算 ${estimateTokens(messages)} token`)
  }
}

// ⑤ 全程账单：cache 命中占比越高，越省钱（cache read 价 ≈ 1/10 input）
const total = totalFresh + totalCached
const pct = total ? ((totalCached / total) * 100).toFixed(1) : "0"
console.log(`\n[账单] 累计新 input=${totalFresh}　cache 命中=${totalCached}　命中率=${pct}%`)
process.exit(0)
