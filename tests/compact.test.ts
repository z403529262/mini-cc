// compact.ts —— 压缩逻辑的关键不是「摘要写得好不好」(那归 LLM)，
// 而是「切割点绝不劈开 tool_use/tool_result 配对」—— 劈开 = API 400，agent 直接崩。
import { test, expect, describe } from "bun:test"
import type Anthropic from "@anthropic-ai/sdk"
import { estimateTokens, findCutPoint, compact } from "../src/compact"
import { fakeCreateClient } from "./helpers"

const u = (content: any): Anthropic.MessageParam => ({ role: "user", content })
const a = (content: any): Anthropic.MessageParam => ({ role: "assistant", content })

// 一段真实形态的 agent 历史：user 任务开头，之后 assistant(tool_use) / user(tool_result) 交替
function agentHistory(rounds: number): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [u("任务")]
  for (let i = 0; i < rounds; i++) {
    msgs.push(a([{ type: "tool_use", id: `t${i}`, name: "bash", input: { command: "ls" } }]))
    msgs.push(u([{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }]))
  }
  msgs.push(a([{ type: "text", text: "完成" }]))
  return msgs
}

describe("estimateTokens", () => {
  test("与 JSON 序列化长度成正比(字符数/3)", () => {
    const msgs = [u("hello")]
    expect(estimateTokens(msgs)).toBe(Math.ceil(JSON.stringify(msgs).length / 3))
  })

  test("内容越多估算越大(单调性)", () => {
    expect(estimateTokens(agentHistory(10))).toBeGreaterThan(estimateTokens(agentHistory(2)))
  })
})

describe("findCutPoint", () => {
  test("切割点落在 tool_result(user) 上时，前移到下一条 assistant", () => {
    const msgs = agentHistory(5) // 长 12：u a u a u a u a u a u a(text)
    const cut = findCutPoint(msgs, 3) // 12-3=9 → msgs[9] 是 tool_result(user) → 前移
    expect(msgs[cut]!.role).toBe("assistant")
  })

  test("★ 核心不变量：保留段内每个 tool_result 的配对 tool_use 也在保留段内(无孤儿)", () => {
    const msgs = agentHistory(8)
    for (let keep = 1; keep <= msgs.length; keep++) {
      const cut = findCutPoint(msgs, keep)
      const kept = msgs.slice(cut)
      const keptToolUseIds = new Set(
        kept.flatMap((m) =>
          Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id) : [],
        ),
      )
      for (const m of kept) {
        if (!Array.isArray(m.content)) continue
        for (const b of m.content as any[]) {
          if (b.type === "tool_result") expect(keptToolUseIds.has(b.tool_use_id)).toBe(true)
        }
      }
    }
  })

  test("keepRecent 大于全长时钳到 1(首条任务永远保留)", () => {
    const msgs = [u("任务"), a("回答")]
    expect(findCutPoint(msgs, 100)).toBe(1)
  })

  test("保留段找不到 assistant 时切到末尾(全压)", () => {
    const msgs = [u("任务"), a("回答"), u("追问1"), u("追问2")]
    expect(findCutPoint(msgs, 1)).toBe(msgs.length)
  })
})

describe("compact", () => {
  test("短对话(没什么可压)原样返回，不调 LLM", async () => {
    const calls: any[] = []
    const client = fakeCreateClient("摘要", calls)
    const msgs = [u("任务"), a("回答")]
    const out = await compact(client, "fake", msgs, 4)
    expect(out).toBe(msgs) // 同一个引用，零开销
    expect(calls.length).toBe(0)
  })

  test("长对话：换成 [user(摘要), ...保留段]，保留段一字不动", async () => {
    const client = fakeCreateClient("这是摘要正文")
    const msgs = agentHistory(6) // 长 14
    const cut = findCutPoint(msgs, 4)
    const out = await compact(client, "fake", msgs, 4)

    expect(out[0]!.role).toBe("user")
    expect(String(out[0]!.content)).toContain("这是摘要正文")
    expect(String(out[0]!.content)).toContain("压缩摘要") // 标明「这是摘要」，模型不会当成真对话
    expect(out.slice(1)).toEqual(msgs.slice(cut)) // 保留段原样
    expect(out[1]!.role).toBe("assistant") // [user(摘要), assistant, ...] 交替合法
    expect(out.length).toBeLessThan(msgs.length)
  })

  test("被压缩段(而非保留段)进了 LLM 的压缩请求", async () => {
    const calls: any[] = []
    const client = fakeCreateClient("摘要", calls)
    const msgs = agentHistory(6)
    const cut = findCutPoint(msgs, 4)
    await compact(client, "fake", msgs, 4)
    const sent = String(calls[0].messages[0].content)
    expect(sent).toContain(JSON.stringify(msgs.slice(0, cut)).slice(0, 200))
  })
})
