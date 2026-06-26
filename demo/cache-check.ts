// D4 验证：智谱 GLM 的 Anthropic 兼容端点到底支不支持 prompt caching？
// 手法：构造一个 >1024 token 的稳定 system，打 cache_control 断点，
// 连发两次完全相同的请求。若支持，第 2 次的 usage 会出现 cache_read_input_tokens。
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})

// 凑一个足够长（>1024 token）的稳定前缀
const bigSystem = "你是一个严谨的编码助手，回答务必简洁。".repeat(200)
const params: Anthropic.MessageCreateParamsNonStreaming = {
  model: "glm-4.6",
  max_tokens: 30,
  system: [{ type: "text", text: bigSystem, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "回复 OK 即可" }],
}

const r1 = await client.messages.create(params)
console.log("第 1 次 usage:", JSON.stringify(r1.usage))
const r2 = await client.messages.create(params)
console.log("第 2 次 usage:", JSON.stringify(r2.usage))

const u = r2.usage as any
if (u.cache_read_input_tokens > 0) {
  console.log(`\n✓ 智谱支持 caching：第 2 次命中 ${u.cache_read_input_tokens} 个 cache tokens`)
} else if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u) {
  console.log("\n△ 返回了 cache 字段但第 2 次未命中（可能前缀太短/被静默失效/TTL）")
} else {
  console.log("\n✗ usage 里没有任何 cache 字段 —— 智谱端点未实现 prompt caching")
}
