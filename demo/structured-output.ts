// D9 帽子补全① 结构化输出 —— 让模型稳定吐「机器可解析」的 JSON。
//
// 为什么要它：agent / 应用经常要把模型输出喂给下游代码(存库 / 调 API / 做判断)。
// 模型输出自由文本，代码没法可靠解析。「裸 prompt 求 JSON」会跑偏：
//   加 ```json 围栏、加前言「好的，这是…」、字段名漂移、偶尔吐不合法 JSON。
//
// 最稳的【通用】解法 = 把 tool calling 当输出通道：
//   定义一个 schema 化的工具，用 tool_choice 强制模型「必须调它」，
//   模型填的 tool input 就是被 schema 约束的结构化对象，JSON.parse 必成功。
//
// 洞见：结构化输出和 tool calling 是同一机制的两面 —— 工具调用本来就是
//   「模型输出一个 JSON Schema 约束的对象(工具入参)」。mini-cc 的工具系统
//   (D2 的 input_schema)本身就是一个结构化输出引擎。
//   (另有原生 structured-output / JSON mode，但绑特定端点；tool 强制法任何 Anthropic 兼容端点都能用。)
//
// 跑法：bun run demo/structured-output.ts   (真 LLM)

import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"

const TEXT = "张三，32 岁，是一名后端工程师，邮箱 zhangsan@example.com，base 在杭州。"

// 目标 schema：从上面这段话抽出结构化字段
const PERSON_SCHEMA: Anthropic.Tool["input_schema"] = {
  type: "object",
  properties: {
    name: { type: "string", description: "姓名" },
    age: { type: "number", description: "年龄(数字)" },
    job: { type: "string", description: "职业" },
    email: { type: "string", description: "邮箱" },
    city: { type: "string", description: "所在城市" },
  },
  required: ["name", "age", "job", "email", "city"],
}

// ── 路 A：裸 prompt 求 JSON(最弱，易跑偏) ────────────────────
async function naiveJson() {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: `从这段话抽出 name/age/job/email/city，只输出 JSON、别的什么都别说：\n${TEXT}` }],
  })
  const raw = (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("")
  console.log("【路 A 裸 prompt】模型原始输出：")
  console.log("  " + raw.replace(/\n/g, "\n  "))
  try {
    const obj = JSON.parse(raw)
    console.log("  → 直接 JSON.parse：成功 ✓", obj)
  } catch (e: any) {
    console.log(`  → 直接 JSON.parse：失败 ✗ (${e.message})`)
    console.log("     多半是带了 ```json 围栏或前言 —— 生产里得写清洗逻辑(抠第一个 {…})，脆弱")
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) { try { console.log("     清洗后再 parse：", JSON.parse(m[0])) } catch {} }
  }
}

// ── 路 B：tool calling 强制 schema(稳) ──────────────────────
async function toolForced() {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    tools: [{ name: "save_person", description: "保存抽取到的人物信息", input_schema: PERSON_SCHEMA }],
    tool_choice: { type: "tool", name: "save_person" }, // 强制：本轮必须调这个工具
    messages: [{ role: "user", content: `从这段话抽取人物信息：\n${TEXT}` }],
  })
  const toolUse = (res.content as any[]).find((b) => b.type === "tool_use")
  console.log("\n【路 B tool 强制 schema】模型填的 tool input(已是结构化对象，无需 parse / 无需清洗)：")
  console.log("  ", toolUse?.input)
  console.log(`  → 类型检查：age 是 number? ${typeof toolUse?.input?.age === "number"}　字段齐? ${["name","age","job","email","city"].every((k) => k in (toolUse?.input ?? {}))}`)
}

console.log("=== 结构化输出：裸 prompt vs tool 强制 schema ===\n")
await naiveJson()
await toolForced()
console.log("\n洞见：tool calling 本来就是「模型输出 schema 约束的 JSON」。把它当输出通道 = 最通用的结构化输出，")
console.log("      不依赖端点的原生 structured-output 特性。mini-cc 的工具系统(input_schema)就是现成的结构化输出引擎。")
process.exit(0)
