// agent.ts runAgent —— loop 内核的行为契约(fake client 注入，离线)。
// 测的是「模型回了 X，loop 该做 Y」：终止/执行回填/未知工具/权限拦截/熔断/中断/计费聚合。
import { test, expect, describe } from "bun:test"
import type Anthropic from "@anthropic-ai/sdk"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "../src/agent"
import { tools as builtinTools } from "../src/tools"
import { makeFakeClient, asstText, asstToolUse } from "./helpers"

function go(scripts: Record<string, Anthropic.Message[]>, key: string, extra?: Partial<Parameters<typeof runAgent>[0]>) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: key }]
  return {
    messages,
    result: runAgent({
      client: makeFakeClient(scripts), model: "fake", system: "s",
      tools: builtinTools, messages, approve: () => true, ...extra,
    }),
  }
}

describe("终止与结果", () => {
  test("end_turn 直接收工：1 轮、返回末条 assistant 的 text", async () => {
    const { result } = go({ K1: [asstText("DONE")] }, "K1")
    const r = await result
    expect(r.text).toBe("DONE")
    expect(r.turns).toBe(1)
    expect(r.stopReason).toBe("end_turn")
    expect(r.aborted).toBe(false)
  })

  test("tool_use → 执行工具 → tool_result 回填 → 下一轮(messages 形态：u/a/u/a)", async () => {
    const { messages, result } = go(
      { K2: [asstToolUse("glob", { pattern: "*.zzz_no_such" }), asstText("FIN")] }, "K2",
    )
    const r = await result
    expect(r.turns).toBe(2)
    expect(messages.length).toBe(4) // user, assistant(tool_use), user(tool_result), assistant(text)
    const toolResult = (messages[2]!.content as any[])[0]
    expect(toolResult.type).toBe("tool_result")
    expect(toolResult.content).toBe("(无匹配)") // glob 真跑了
    expect((messages[2]!.content as any[])[0].tool_use_id).toBe((messages[1]!.content as any[])[0].id) // 配对
  })

  test("usage 聚合：fresh = 各轮 input_tokens 之和(fake 每轮 1)", async () => {
    const { result } = go({ K3: [asstToolUse("glob", { pattern: "*.zzz" }), asstText("FIN")] }, "K3")
    expect((await result).usage.fresh).toBe(2)
  })
})

describe("异常路径(全部回填、不崩 loop)", () => {
  test("未知工具 → is_error 的 tool_result，loop 继续走完", async () => {
    const { messages, result } = go({ K4: [asstToolUse("no_such_tool", {}), asstText("FIN")] }, "K4")
    const r = await result
    expect(r.text).toBe("FIN") // 没崩
    const tr = (messages[2]!.content as any[])[0]
    expect(tr.is_error).toBe(true)
    expect(tr.content).toContain("未知工具")
  })

  test("危险命令 → deny：不执行、回填 [权限拒绝]，approve 根本不被问", async () => {
    let asked = false
    const { messages, result } = go(
      { K5: [asstToolUse("bash", { command: "rm -rf /tmp/whatever" }), asstText("FIN")] }, "K5",
      { approve: () => { asked = true; return true } },
    )
    await result
    expect(asked).toBe(false) // deny 不走 ask，防「手滑按了 y」
    const tr = (messages[2]!.content as any[])[0]
    expect(tr.is_error).toBe(true)
    expect(tr.content).toContain("[权限拒绝]")
  })

  test("ask 被拒 → 不执行、回填 [用户拒绝]，文件确实没写", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicc-agent-"))
    try {
      const path = join(tmp, "should_not_exist.txt")
      const { messages, result } = go(
        { K6: [asstToolUse("write_file", { path, content: "x" }), asstText("FIN")] }, "K6",
        { approve: () => false },
      )
      await result
      expect(existsSync(path)).toBe(false)
      expect((messages[2]!.content as any[])[0].content).toContain("[用户拒绝]")
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  test("ask 被批 → 正常执行", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicc-agent-"))
    try {
      const path = join(tmp, "approved.txt")
      const { result } = go(
        { K7: [asstToolUse("write_file", { path, content: "yes" }), asstText("FIN")] }, "K7",
      )
      await result
      expect(existsSync(path)).toBe(true)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe("熔断与中断", () => {
  test("maxTurns 熔断：模型无限要工具也停得下来，stopReason=max_turns", async () => {
    // 脚本只有一条 tool_use，越界后停在最后一条 = 每轮都要调工具 → 靠熔断退出
    const { result } = go({ K8: [asstToolUse("glob", { pattern: "*.zzz" })] }, "K8", { maxTurns: 3 })
    const r = await result
    expect(r.stopReason).toBe("max_turns")
    expect(r.turns).toBe(4) // 第 4 次尝试时触发熔断
  })

  test("signal 已 aborted → 一轮不跑直接返回 aborted:true", async () => {
    const ac = new AbortController()
    ac.abort()
    const { messages, result } = go({ K9: [asstText("NEVER")] }, "K9", { signal: ac.signal })
    const r = await result
    expect(r.aborted).toBe(true)
    expect(messages.length).toBe(1) // 连一条 assistant 都没产生
  })
})
