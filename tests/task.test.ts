// task.ts —— 子 agent 的四个关键性质：结果回收 / 上下文隔离 / 递归防护 / 工具集筛选。
// (demo/task-check.ts 是 D7 当天的教学验证脚本；这里是同一批性质的正式测试化。)
import { test, expect, describe } from "bun:test"
import type Anthropic from "@anthropic-ai/sdk"
import { runAgent } from "../src/agent"
import { makeTaskTool, selectSubagentTools } from "../src/task"
import { tools as builtinTools } from "../src/tools"
import { makeFakeClient, asstText, asstToolUse } from "./helpers"

describe("selectSubagentTools 筛选规则(纯逻辑)", () => {
  const fakeTask = makeTaskTool({ client: {} as any, model: "x", parentTools: builtinTools })
  const mcpFake = { name: "mcp__calc__add", readOnly: false, description: "", input_schema: {} as any, execute: async () => "" }
  const sub = selectSubagentTools([...builtinTools, mcpFake, fakeTask])

  test("只读工具进(read/glob/grep)", () => {
    for (const n of ["read_file", "glob", "grep"]) expect(sub.some((t) => t.name === n)).toBe(true)
  })

  test("写工具被挡(write/edit/bash)", () => {
    for (const n of ["write_file", "edit_file", "bash"]) expect(sub.some((t) => t.name === n)).toBe(false)
  })

  test("MCP 工具放行 —— 即便 readOnly:false(不被「只读一刀切」误伤)", () => {
    expect(sub.some((t) => t.name === "mcp__calc__add")).toBe(true)
  })

  test("★ 递归防护：task 自身被剔除(它 readOnly:true，不剔就会被只读条件选中→无限套娃)", () => {
    expect(sub.some((t) => t.name === "task")).toBe(false)
  })

  test("task 工具自身 readOnly=true(派生子 agent 是安全操作，自动放行)", () => {
    expect(fakeTask.readOnly).toBe(true)
  })
})

describe("端到端(fake client)：隔离与回收", () => {
  test("★ 上下文隔离：子 agent 的中间过程不进主 messages，主只拿到最终结论", async () => {
    const client = makeFakeClient({
      MAINTASK: [asstToolUse("task", { description: "调研", prompt: "SUBTASK 读文件后汇报" }), asstText("主答案")],
      SUBTASK: [asstToolUse("glob", { pattern: "MIDDLE_MARKER_*.zzz" }), asstText("子结论 CONCLUSION")],
    })
    const taskTool = makeTaskTool({ client, model: "x", parentTools: builtinTools })
    const mainMessages: Anthropic.MessageParam[] = [{ role: "user", content: "MAINTASK" }]
    await runAgent({
      client, model: "x", system: "s", tools: [...builtinTools, taskTool],
      messages: mainMessages, approve: () => true,
    })

    const dump = JSON.stringify(mainMessages)
    expect(mainMessages.length).toBe(4)          // 主只有 2 轮：调 task + 出答案
    expect(dump).toContain("子结论 CONCLUSION")   // 结论回收了
    expect(dump).not.toContain("MIDDLE_MARKER")  // 子 agent 读文件的中间过程没进主
  })

  test("缺 prompt → 报错回填，不崩", async () => {
    const taskTool = makeTaskTool({ client: {} as any, model: "x", parentTools: builtinTools })
    expect(await taskTool.execute({ description: "x" })).toContain("[task 失败]")
  })
})
