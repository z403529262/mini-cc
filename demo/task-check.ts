// D7 子 agent 协议层/逻辑层验证 —— 注入 fake client，不联网、不花钱(同 D3-D6 套路)。
// 验证 5 件事：① 结果回收 ② 上下文隔离 ③ 递归防护 ④ 只读子集 ⑤ task 权限默认。
import type Anthropic from "@anthropic-ai/sdk"
import { runAgent } from "../src/agent"
import { makeTaskTool, selectSubagentTools } from "../src/task"
import { tools as builtinTools } from "../src/tools"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`✅ ${name}`) }
  else { fail++; console.log(`❌ ${name}　${extra}`) }
}

// —— fake client：模拟 client.messages.stream(...) → { on, finalMessage } ——
// 路由：按「首条 user 内容」选脚本；轮次：按当前 messages 里已有的 assistant 条数决定返回第几步。
// 主 agent 和子 agent 各有独立的 messages 数组，所以轮次计数天然互不干扰。
function asstText(text: string): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "fake",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } } as any
}
function asstToolUse(name: string, input: any): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "fake",
    content: [{ type: "tool_use", id: "t" + Math.random().toString(36).slice(2), name, input }],
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } } as any
}
function makeFakeClient(scripts: Record<string, Anthropic.Message[]>): Anthropic {
  return {
    messages: {
      stream(params: any) {
        const first = params.messages[0]
        const key = typeof first.content === "string" ? first.content : JSON.stringify(first.content)
        const scriptKey = Object.keys(scripts).find((k) => key.includes(k))
        if (!scriptKey) throw new Error("fake client: 无匹配脚本 for " + key.slice(0, 40))
        const script = scripts[scriptKey]!
        const turnIdx = params.messages.filter((m: any) => m.role === "assistant").length
        const msg = script[Math.min(turnIdx, script.length - 1)]!
        return { on() {}, async finalMessage() { return msg } }
      },
    },
  } as any
}

// === ③④⑤ 结构断言（纯逻辑，无需 LLM）===
const fakeTask = makeTaskTool({ client: {} as any, model: "x", parentTools: builtinTools })
const sub = selectSubagentTools([...builtinTools, fakeTask]) // 故意把 task 也放进父集，考验剔除
check("③ 递归防护：子 agent 工具集不含 task", !sub.some((t) => t.name === "task"))
check("④ 只读子集：子 agent 工具全部 readOnly", sub.every((t) => t.readOnly), `得到 ${sub.map((t) => t.name).join(",")}`)
check("⑤ task 工具 readOnly=true（自动放行不打扰用户）", fakeTask.readOnly === true)

// === ① 结果回收：runAgent 返回【末条 assistant 的 text】，不是中间轮 ===
{
  const client = makeFakeClient({
    RECALL: [asstToolUse("glob", { pattern: "*.zzz" }), asstText("FINAL_REPORT")],
  })
  const r = await runAgent({
    client, model: "x", system: "s", tools: builtinTools,
    messages: [{ role: "user", content: "RECALL" }], approve: () => true,
  })
  check("① 结果回收：取末条 assistant text", r.text === "FINAL_REPORT", `得到「${r.text}」`)
}

// === ② 上下文隔离：子 agent 中间过程不进主 messages ===
{
  const client = makeFakeClient({
    MAINTASK: [asstToolUse("task", { description: "调研", prompt: "SUBTASK 读文件后汇报" }), asstText("主答案(基于子结论)")],
    SUBTASK: [asstToolUse("glob", { pattern: "MIDDLE_MARKER_*.zzz" }), asstText("子结论 CONCLUSION")],
  })
  const taskTool = makeTaskTool({ client, model: "x", parentTools: builtinTools })
  const mainTools = [...builtinTools, taskTool]
  const mainMessages: Anthropic.MessageParam[] = [{ role: "user", content: "MAINTASK" }]
  await runAgent({ client, model: "x", system: "s", tools: mainTools, messages: mainMessages, approve: () => true })

  const dump = JSON.stringify(mainMessages)
  // 主只走 2 轮：user → assistant(调 task) → user(tool_result=子结论) → assistant(主答案) = 4 条。
  // 子 agent 那 2 轮(glob + 汇报)全在子 messages 里，没进主 —— 这就是隔离。
  check("② 隔离：主 messages 精简未被子 agent 多轮膨胀", mainMessages.length === 4, `实际 ${mainMessages.length} 条`)
  check("② 隔离：主拿到的是子 agent 回传的【结论】", dump.includes("子结论 CONCLUSION"))
  check("② 隔离：子 agent 读文件的中间过程【不在】主 messages", !dump.includes("MIDDLE_MARKER"))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
