// D4 验证：上下文压缩是否 ① 真的缩小 token ② 不劈开 tool_use/tool_result 配对 ③ 压缩后还能继续请求。
import Anthropic from "@anthropic-ai/sdk"
import { compact, estimateTokens, findCutPoint } from "../src/compact"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})

// 构造一个含 3 组配对 tool_use/tool_result 的长对话（每个结果撑大，逼出压缩价值）
const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "任务：依次读取 a/b/c 三个文件并汇总" },
  { role: "assistant", content: [{ type: "text", text: "先读 a" }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内容A ".repeat(400) }] },
  { role: "assistant", content: [{ type: "text", text: "再读 b" }, { type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "内容B ".repeat(400) }] },
  { role: "assistant", content: [{ type: "text", text: "最后读 c" }, { type: "tool_use", id: "t3", name: "read_file", input: { path: "c" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "内容C ".repeat(400) }] },
]

// 配对检查：每个 tool_result 都必须能在它之前找到对应的 tool_use
function checkPairing(msgs: Anthropic.MessageParam[]): string {
  const seen = new Set<string>()
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === "tool_use") seen.add(b.id)
      if (b.type === "tool_result" && !seen.has(b.tool_use_id)) return `✗ 孤儿 tool_result: ${b.tool_use_id}`
    }
  }
  return "✓ 配对完整"
}

console.log(`压缩前：${messages.length} 条，估算 ${estimateTokens(messages)} token`)
const cut = findCutPoint(messages, 4)
console.log(`切割点 cut=${cut} → 保留段首条 role=${messages[cut]?.role}（必须是 assistant）`)

const compacted = await compact(client, "glm-4.6", messages, 4)
console.log(`压缩后：${compacted.length} 条，估算 ${estimateTokens(compacted)} token`)
console.log(`配对检查：${checkPairing(compacted)}`)

// 压缩后能否继续请求（不报 400 tool_use/tool_result 配对错误）
const r = await client.messages.create({ model: "glm-4.6", max_tokens: 50, messages: compacted })
console.log(`压缩后继续请求：stop_reason=${r.stop_reason} ✓ 不报错`)
