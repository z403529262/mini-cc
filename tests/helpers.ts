// 测试共享工具 —— fake client。
//
// 测试策略(D10 的核心取舍)：测「协议层 + 逻辑层」，不测 LLM 输出本身。
// LLM 输出非确定、联网、花钱 —— 那是 eval(demo/eval.ts) 的事；单元测试要的是
// 确定 / 离线 / 免费 / 可上 CI。做法 = 把「模型会怎么回」用脚本写死，注入 fake client，
// 专门验证 loop 拿到各种回复后的行为(执行/回填/拦截/熔断)对不对。
// 这能成立，全靠 runAgent 把 client 参数化了 —— 依赖注入的第三次兑现(D7 task / D8 eval / D10 tests)。
import type Anthropic from "@anthropic-ai/sdk"

// 造一条「纯文本回复」的 assistant 消息(stop_reason=end_turn → loop 该收工)
export function asstText(text: string): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: [{ type: "text", text }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as any
}

// 造一条「调用工具」的 assistant 消息(stop_reason=tool_use → loop 该执行工具再回填)
export function asstToolUse(name: string, input: any): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: [{ type: "tool_use", id: "t" + Math.random().toString(36).slice(2), name, input }],
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as any
}

// fake client(stream 版，给 runAgent 用)：
//   路由 —— 按「首条 user 内容」匹配脚本 key(主/子 agent 各有独立首条，天然分流)；
//   轮次 —— 数当前 messages 里已有的 assistant 条数，决定回放脚本第几步；
//   越界 —— 停在脚本最后一条(方便测 maxTurns 熔断：一条 tool_use 无限重复)。
export function makeFakeClient(scripts: Record<string, Anthropic.Message[]>): Anthropic {
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

// fake client(create 版，给 compact 用)：固定回一段文本当"摘要"，并把收到的请求记下来供断言
export function fakeCreateClient(replyText: string, calls?: any[]): Anthropic {
  return {
    messages: {
      async create(params: any) {
        calls?.push(params)
        return asstText(replyText)
      },
    },
  } as any
}
