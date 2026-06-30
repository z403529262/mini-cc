# mini-cc

一个最小化的 Claude Code —— 用约 100 行 TypeScript，实现一个能**自主调用工具、循环推进直到完成任务**的编码 agent。

> 学习项目：从零手写，吃透 agent 的内核。不是又一个 LLM 聊天封装。

## 它是什么

mini-cc 的核心是一个 **agent loop**：模型自己决定调用 `bash` 工具、读取执行结果、规划下一步，循环推进直到任务完成 —— 这正是 Claude Code 这类编码 agent 的内核。

实测：给它一句「列出当前目录最大的 3 个文件，并推测这个项目是干嘛的」，它会自主循环十余轮，依次 `pwd` → `ls` → `find` → `cat` 各文件（甚至读自己的源码），最后准确总结出项目用途。

## 快速开始

```bash
bun install
export ANTHROPIC_AUTH_TOKEN=<你的 key>     # 见下方 Provider
bun run src/m1.ts "列出当前目录最大的 3 个文件，并推测这个项目是干嘛的"
```

不带参数则跑默认任务。

### Provider

默认接**智谱 GLM** 的 Anthropic 兼容端点（国内直连，无需代理）：

- `src/m1.ts` 里 `baseURL` 指向 `https://open.bigmodel.cn/api/anthropic`
- `apiKey` 读环境变量 `ANTHROPIC_AUTH_TOKEN`
- `MODEL` 为 `glm-4.6`

要换成 Anthropic 官方或其他兼容端点，改 `src/m1.ts` 顶部的 `baseURL` / `MODEL` 即可（`@anthropic-ai/sdk` 对任意 Anthropic 兼容端点通用）。

## 核心：agent loop 就这么点

```ts
const messages = [{ role: "user", content: 任务 }]

while (true) {
  const res = await client.messages.create({ model, system, tools, messages })
  messages.push({ role: "assistant", content: res.content })   // 记住模型这轮的输出
  if (res.stop_reason !== "tool_use") break                    // 不再调工具 → 收工
  const results = res.content.filter(b => b.type === "tool_use")
    .map(b => ({ type: "tool_result", tool_use_id: b.id, content: runBash(b.input.command) }))
  messages.push({ role: "user", content: results })            // 工具结果回填 → 下一轮
}
```

- `tools` 用 JSON Schema 描述工具，模型据此决定**何时**调用、传**什么**参数
- `stop_reason === "tool_use"` → 执行工具、把结果作为 `tool_result` 回填，再循环
- `stop_reason === "end_turn"` → 任务完成，跳出

## 里程碑

- [x] **M0** 单轮问答 — `src/m0.ts`
- [x] **M1** agent loop + bash 工具 — `src/m1.ts`
- [x] **M2** 多工具：read / write / edit / glob / grep — `src/tools.ts` + `src/m2.ts`
- [x] **M3** 流式输出 + 可中断（Esc）— `src/m3.ts`（execute 异步化见 `src/tools.ts`；中断验证 `demo/abort-check.ts`）
- [x] **M4** 上下文压缩 + prompt caching — `src/m4.ts`（caching：SYSTEM 断点 + `withRollingCache`）+ `src/compact.ts`（配对安全压缩）；验证 `demo/compact-check.ts`
- [x] **M5** 工具权限审批（危险命令拦截）— `src/permission.ts`（三态 allow/ask/deny）+ `src/m5.ts`（execute 前权限门）；验证 `demo/permission-check.ts` + `demo/permission-flow-check.ts`
- [x] **M6** MCP 客户端（接外部工具）— `src/mcp.ts`（手写 stdio JSON-RPC，把 MCP 工具包装成本地 `Tool`）+ `src/m6.ts`（连接后并入 `toolMap`，loop/权限门零改动）；最小 server `demo/mcp-server-calc.ts`，验证 `demo/mcp-check.ts`
- [x] **M7** 子 agent（隔离上下文的 Task）— `src/agent.ts`（把 m0-m6 的 inline loop 抽成可复用、可嵌套、可注入 client 的 `runAgent` 内核，主 / 子 agent 共用）+ `src/task.ts`（`makeTaskTool` 把「带独立上下文的子 loop」包成一个只读、防递归的 `Tool`）+ `src/m7.ts`（壳：连 MCP + 接 task + 把中断 / 审批当回调注入 `runAgent`）；验证 `demo/task-check.ts`（fake client，结果回收 / 上下文隔离 / 递归防护 7 断言）

> **延伸（LLM 应用层，非内核里程碑）**
> - **D8 评估与可观测** — `demo/eval.ts` + `demo/eval-tasks.ts`：给 agent 固定任务集 + 判据，批量跑统计通过率 / 轮数 / token（程序化断言 + LLM-judge）。详见 `docs/D8-评估与可观测对照.md`
> - **D9 RAG 与检索** — `demo/rag-mini.ts`：手写最小 RAG（chunk → TF-IDF → 余弦 top-k → 生成）+ agentic search 对照，讲清「RAG vs agentic」取舍、以及为什么 Claude Code 不挂向量库。详见 `docs/D9-RAG与检索对照.md`；附录 `docs/D9-附录-生产级RAG深读.md`（解剖 Anthropic Contextual Retrieval 源码 + 映射经典六步 + 批判性读 RAG benchmark）

## 技术栈

Bun · TypeScript · [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)

## License

MIT
