import type Anthropic from "@anthropic-ai/sdk"

// 粗略估算对话 token：字符数 / 3（中文约 1.5-2 char/token、英文约 4，混合取 3 折中）。
// 真要准用 messages.count_tokens API；mini-cc 估算够用来决定「该不该压了」。
export function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 3)
}

// ★ 配对安全的切割点：保留段的首条必须是 assistant。
// 为什么？agent 对话里 user 消息除了首条任务，其余都是 tool_result；
// 若保留段从 tool_result(user) 开头，它配对的 tool_use 落在被压缩段里 → 孤儿 tool_result → API 400。
// 让保留段从 assistant 起，则：压缩段以「配对完整的 tool_result」收尾，保留段内 assistant 的
// tool_use 的 tool_result 也都在保留段内 → 两段各自配对自洽，绝不劈开。
export function findCutPoint(messages: Anthropic.MessageParam[], keepRecent: number): number {
  let cut = Math.max(1, messages.length - keepRecent)
  while (cut < messages.length && messages[cut]!.role !== "assistant") cut++
  return cut // 压缩 [0..cut-1]，保留 [cut..]
}

// 压缩：把 messages[0..cut-1] 用一次 LLM 调用总结成一条 user 摘要，
// 新 messages = [user(摘要)] + messages[cut..]。
// 保留段以 assistant 开头 → [user(摘要), assistant, user, …] 交替合法 + 配对完整。
export async function compact(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
  keepRecent = 4,
): Promise<Anthropic.MessageParam[]> {
  const cut = findCutPoint(messages, keepRecent)
  if (cut <= 1) return messages // 没什么可压

  const toCompress = messages.slice(0, cut)
  const keep = messages.slice(cut)

  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system:
      "你是对话压缩器。把给定的 agent 对话历史压缩成简洁中文摘要，必须保留：原始任务、已完成的关键操作及其结果、当前进展、待办事项。只输出摘要正文，不要寒暄。",
    messages: [
      {
        role: "user",
        content: "压缩以下对话历史（JSON）：\n\n" + JSON.stringify(toCompress).slice(0, 12000),
      },
    ],
  })
  const summary = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("\n")

  return [
    { role: "user", content: `[以下是之前 ${toCompress.length} 条对话的压缩摘要]\n${summary}` },
    ...keep,
  ]
}
