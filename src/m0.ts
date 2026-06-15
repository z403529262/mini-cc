import Anthropic from "@anthropic-ai/sdk"

// 智谱 GLM 的 Anthropic 兼容端点（bigmodel.cn 国内直连，不走代理）
// apiKey 复用你 shell 里现成的 ANTHROPIC_AUTH_TOKEN（就是智谱 key）
const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})

const input = process.argv.slice(2).join(" ") || "用一句话解释 agent loop 是什么"

// 最小单轮：发一条消息 → 拿一条回复。没有循环、没有工具。
const res = await client.messages.create({
  model: "glm-4.6",
  max_tokens: 1024,
  messages: [{ role: "user", content: input }],
})

for (const b of res.content) if (b.type === "text") console.log(b.text)
console.log(`\n[stop_reason=${res.stop_reason}  in=${res.usage.input_tokens} out=${res.usage.output_tokens} tokens]`)
