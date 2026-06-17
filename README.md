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
- [ ] **M4** 上下文压缩 + prompt caching
- [ ] **M5** 工具权限审批（危险命令拦截）
- [ ] **M6** MCP 客户端
- [ ] **M7** 子 agent（隔离上下文的 Task）

## 技术栈

Bun · TypeScript · [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)

## License

MIT
