# D7 / M7 — 子 agent（隔离上下文的 Task）：mini-cc × cc-haha 对照

> 双线螺旋第 7 站。先讲透「是什么 / 为什么」，再看 mini-cc 怎么用百来行做出来，最后对照真 CC(cc-haha) 多出来的那些。
> 配套代码：`src/agent.ts`(runAgent 内核) · `src/task.ts`(task 工具) · `src/m7.ts`(壳) · `demo/task-check.ts`(验证)

---

## 第一部分：是什么 / 为什么

### 1. 是什么

**子 agent(subagent)**：主 agent 在一次工具调用里，派生一个**带独立 `messages`(独立上下文窗口)的子 agent** 去完成一个相对独立的活；子 agent 在自己的上下文里读文件、调工具、循环推进，干完只把**最终一段文字总结**回传主 agent。中间过程全留在子上下文、用完即弃。

类比(给 Android 背景)：很像开一个 `IntentService` / `WorkManager` 后台任务——主线程(主 agent)把一件耗时的活丢给它，自己不被阻塞、也不关心它中间干了啥，只等它回调一个结果。区别是这里"隔离"的不是线程，是**上下文(token 窗口)**。

用户在 Claude Code 里见到的 `Task` 工具、`Explore` agent，就是这个东西。

### 2. 为什么要它：上下文是稀缺资源

agent 的上下文窗口是**有限且越用越贵**的(token 越多越慢越花钱，还会稀释注意力)。考虑一个真实子任务：

> "搞清楚 `src/` 下每个 `.ts` 文件分别实现了哪个里程碑"

要回答它，得 `glob` 列目录 + `read` 十几个文件。**如果这些全在主 loop 里做**，十几个文件的完整内容(几千 token)会永久焊死在主 `messages` 里——可主 agent 其实只需要那一句**结论**("m1=loop，m2=多工具…")。中间那一大坨原文，对主 agent 后续的任何决策都是纯噪音。

子 agent 解决的就是这个：把"**高消耗、只需结论**"的脏活外包出去。

**端到端实测的铁证**(本次 `m7.ts` 跑出来的账单)：

| | 子 agent `[sub]` | 主 agent `[main]` |
|---|---|---|
| 干了什么 | `read` 了 agent.ts + task.ts 两个上百行文件 | 只调了一次 `task`，收到 472 字结论 |
| 吃进的 token | 第 2 轮 `input=3268`(含两文件全文) | 全程 `input=2700`，**不含任何文件全文** |

两个文件的全文 token 全部花在子上下文，主上下文一个字节都没沾。这就是"隔离"省下来的东西，量化、可见。

### 3. D7 的题眼：子 agent 倒逼 loop 抽象

这是面试最该讲的一点。**子 agent 的本质 = 在一次工具调用里，再完整跑一遍 agent loop。** 所以做子 agent 的第一步，不是写子 agent，而是：

> 把"跑一个 agent 直到完成"从 m0-m6 那种**顶层 `while` 脚本**里抽出来，变成一个**可复用、可嵌套、可注入**的函数 `runAgent()`。

m0-m6 每个文件都是一段顶层 `while(true){...}`，loop 内核和外壳(readline 键盘监听 / 账单打印 / `process.exit`)缠死在一起，**没法被第二次调用**。D7 第一刀就是把内核剥出来——主 agent 和子 agent 共用同一个 `runAgent`。

真 CC 完全是同一个套路(已坐实)：`AgentTool` 的 `call()` 里调的 `runAgent`(`AgentTool.tsx:736`)，和主对话用的是同源的引擎。**"子 agent 能成立"就是"loop 是个好抽象"的兑现**——这和 D6"MCP 工具能塞进 toolMap 是 Tool 抽象的兑现"是同一种回报。

---

## 第二部分：mini-cc 怎么做的

### 4. `runAgent` 内核：把外壳"参数化"掉（`src/agent.ts`）

抽函数的难点不在搬运 loop 主体，而在**怎么把外壳依赖变成参数**。m6 的 loop 里混了四样外壳东西，D7 全变成注入项：

| m6 里写死的外壳 | D7 参数化成 | 主 agent 传 | 子 agent 传 |
|---|---|---|---|
| 交互式 `askApproval`(等键盘 y/n) | `approve(tool,input,brief)` 回调 | 交互式 y/n | `() => true`(只读集本不触发) |
| `process.stdout.write`(流式打字) | `onText(delta)` 回调 | 写 stdout | 不传(静默) |
| `ac.signal`(Esc 中断) | `signal` | 主 AbortController | 继承主的 signal |
| `console.log` 各种过程日志 | `verbose` + `label` | `true`/`"main"` | `true`/`"sub"` |

于是 `runAgent` 内核自己只管最纯粹的五步：**流式取回复 → 权限门(`checkPermission`) → 执行工具 → 回填 `tool_result` → 压缩 → 循环**。它不碰 `readline`、不碰 `process.exit`——纯到能被嵌套调用。返回 `{ text, usage, turns, stopReason, aborted }`，其中 `text` = 末条 assistant 的 text 拼接 = agent 的"最终汇报"。

```ts
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  // toolMap/toolSchemas 由传入的 tools 现建 —— 同一内核，主给全量、子给只读子集
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  // ... while loop：stream → checkPermission(deny回填/ask调approve) → execute → 回填 → compact → 循环
}
```

### 5. `task` 工具：把"一整个子 agent"包成一个 `Tool`（`src/task.ts`）

这是 D6 验证过的「注册表 + 权限门正交」的二次复用：**MCP 工具能包成 `Tool` 塞进 `toolMap`，整个子 agent 也能。** 对主 loop 而言，`task` 和 `read_file` 没有任何区别——都是 `toolMap` 里一个有 `execute` 的对象。区别只在 `execute` 内部：它用受限工具集 + 一条全新 messages，**再调一次 `runAgent`**。

```ts
execute: async (input, signal) => {
  const subTools = selectSubagentTools(parentTools)              // 只读集 + 剔除 task
  const subMessages = [{ role: "user", content: input.prompt }] // ★ 全新数组 = 隔离的关键
  const result = await runAgent({
    client, model, system: SUBAGENT_SYSTEM, tools: subTools,
    messages: subMessages, approve: () => true, signal, maxTurns: 15, label: "sub",
  })
  return result.text          // 只把"最终汇报"交回主 loop；subMessages 随 execute 结束被丢弃
}
```

### 6. 三个核心机制，逐个看

**① 上下文隔离** = 子 agent 用一条**全新的 `messages` 数组**(`subMessages`)。它和主 `messages` 是两个物理上不同的数组，子 agent 在它上面 push 十几轮，主 `messages` 一条都不会多。隔离不是什么魔法，就是"换个数组"。

**② 递归防护** = 一行 filter，半个条件是关键：

```ts
export function selectSubagentTools(parentTools: Tool[]): Tool[] {
  return parentTools.filter((t) => t.readOnly && t.name !== "task")
}
```

- `t.readOnly`：只读集(read/glob/grep)。一举两得——子 agent 不改文件、`checkPermission` 全 `allow`，于是子 agent 能**全自动跑完不卡审批**(它跑在工具调用里，没有终端能弹 y/n)。
- `t.name !== "task"`：**这半个条件才是递归防护那一刀**。因为 `task` 工具自己 `readOnly:true`，会被前半个条件选中！不显式剔除，子 agent 的工具表里就有 `task`，它就能再派生子 agent、无限递归。剔掉它，子 agent 从源头看不到 `task`。

> ⚠️ **这行有个已知债**：`t.readOnly` 这一刀会**误伤非只读的 MCP 工具**——mini-cc 里 `mcp__calc__*` 是 `readOnly:false`(D6 的保守策略)，于是子 agent 在 mini-cc 里**拿不到 MCP 工具**。而真 CC 恰恰相反，MCP 工具对所有 agent 优先放行(见 §9、§17)。正确改法是给 MCP 开绿色通道：`filter((t) => (t.readOnly || t.name.startsWith("mcp__")) && t.name !== "task")`。

**③ 结果回收** = 取末条 assistant 的 text(`agent.ts` 的 `lastText`)。子 agent 的"汇报"就是它最后一句话，这句话成为主 loop 里那次 `task` 调用的 `tool_result`。

### 7. 验证

- **单元层**(`demo/task-check.ts`，fake client 注入，不联网不烧钱)：7 断言全绿——结果回收取末条 / 隔离后主 messages 只 4 条不被子 agent 多轮膨胀 / 主拿到的是结论不是中间过程 / 递归防护子集无 task / 只读子集 / task `readOnly:true`。`runAgent` 接受注入 client 正是为了可测——这是好设计的副产品。
- **端到端**(真 LLM)：`AUTO_APPROVE=1 bun run src/m7.ts "用 task 调研 agent.ts 和 task.ts…"` → 主调 task → 子 `[sub]` 自主 read 两文件 → 回 472 字结论 → 主基于结论作答，2 轮收工。隔离铁证见 §2 表格。

---

## 第三部分：cc-haha 对照（真 CC 多了什么）

### 8. 架构：真 CC 是三层，mini-cc 合成两层

| 层 | cc-haha | mini-cc |
|---|---|---|
| 路由 | `AgentTool.call()`：选 agent 类型、查权限、判 fork/teammate/后台(`AgentTool.tsx:240+`) | `task.execute()`：直接用固定子 agent |
| 装配 | `runAgent()`(`async function*` generator，`runAgent.ts:248`)：装配 agent 定义 / 工具集 / system prompt / skills / MCP | (并入 `runAgent`) |
| 引擎 | `query()`(底层对话 loop，`runAgent.ts:748` `for await (const message of query(...))`) | `runAgent()` 的 while |

真 CC 的 `runAgent` 是个**流式 generator**——`yield` 出每条 message 给上层渲染。mini-cc 把"装配 + 引擎"合进一个 `runAgent`，不做流式 yield(只在末尾返回 text)。这是合理简化：mini-cc 的目标是讲清"子 agent = 嵌套 loop + 隔离 messages"，三层拆分是工程规模上来后的事。

### 9. 工具集筛选：`filterToolsForAgent` vs 一行 filter

cc-haha `filterToolsForAgent`(`agentToolUtils.ts:70`) 比 mini-cc 的一行复杂得多，但骨架同构：

- **MCP 工具一律放行**(`:83` `mcp__` 前缀直接 `return true`，**先于所有禁用名单判断**)——子 agent 照样能用外部工具；更强的是 MCP server 对父 **additive**(`runAgent.ts:648` "additive to parent's servers")，子 agent 继承父的全部 server、还能再加自己专属的。**为什么有意这么设计见 §17。**
- **`ALL_AGENT_DISALLOWED_TOOLS`**(`:94`)：所有子 agent 都禁的工具集(含 `Agent` 工具本身——这就是递归防护，见 §10)
- **`CUSTOM_AGENT_DISALLOWED_TOOLS`**(`:97`)：自定义 agent 额外再禁一批
- **`isAsync` 后台 agent** 只允许 `ASYNC_AGENT_ALLOWED_TOOLS` 白名单(`:100`)
- 再叠加 `resolveAgentTools`(`:122`)：处理 `tools: ['*']` 通配、`disallowedTools` 黑名单、`isMainThread` 跳过过滤(`:137`，主线程用全量工具)

mini-cc 的 `selectSubagentTools` = 把这套压缩成"只读 + 剔除 task"一行。同一个意图(给子 agent 一个受控的、不含派生能力的子集)，不同的规模。

### 10. 递归防护：真 CC 两条路并存

这是个精彩的对照点：

| | 触发对象 | 怎么防 |
|---|---|---|
| **一般子 agent** | `subagent_type` 指定的 | 工具集层面剔除 `Agent`(走 `ALL_AGENT_DISALLOWED_TOOLS`) —— 子 agent 根本看不到 Agent 工具 |
| **fork 子 agent** | 省略 `subagent_type`(实验特性) | **保留** Agent 工具(为 cache 字节对齐)，改用**运行时检测** `isInForkChild(messages)`(`forkSubagent.ts:78`)——扫历史里有没有 fork boilerplate tag，有就 `throw`(`AgentTool.tsx:332`) |

mini-cc 取的是**第一条路**(工具集剔除)——最简最稳。fork 那条"保留工具 + 运行时拦截"是为了一个 mini-cc 不追求的目标：**让所有 fork 子 agent 的 API 请求前缀字节一致，从而共享 prompt cache**(`buildForkedMessages` 给所有 fork 子用同一个 placeholder tool_result，只有最后的 directive 文本不同，`forkSubagent.ts:107`)。

### 11. 结果回收：mini-cc 少了一个 fallback

cc-haha `finalizeAgentTool`(`agentToolUtils.ts:276`) 和 mini-cc `lastText` 都是"取末条 assistant 的 text"，但真 CC 多一层兜底(`:304-317`)：

> 如果末条 assistant 是**纯 tool_use**(loop 中途退出、没来得及说话)，就往前找最近一条**有 text** 的 assistant。

mini-cc 的 `lastText` 没做这个——若子 agent 在 tool_use 轮被熔断/中断，`lastText` 会返回空串。这是个**已知简化**(正常 end_turn 收尾的子 agent 不受影响)，也是一个一眼能说出口的"可改进点"，面试时主动提，显得你读懂了边界。

此外真 CC 收尾还发 `tengu_cache_eviction_hint`(`:338`)告诉推理层"这个子 agent 的 cache 链可以回收了"——精细 cache 生命周期管理，mini-cc 无。

### 12. fork 模式：一个"长得像主 agent 的子 agent"

mini-cc 只做"**独立 messages**"这一种隔离；真 CC 有两种，第二种(fork)最容易让人绕进去：

- **独立上下文子 agent**(默认)：和 mini-cc 一样，全新 messages，子 agent 看不到主对话。
- **fork 子 agent**(实验)：反过来——**继承父的完整对话上下文 + 父已渲染的 system prompt 字节**(`runAgent.ts:508` `override.systemPrompt`、`:370` `forkContextMessages`)，并且 `tools:['*']` 全量工具(`forkSubagent.ts:60` `FORK_AGENT`)。为什么继承？**为了 cache**——子复用父的前缀字节就能命中父的 prompt cache；`buildForkedMessages`(`:107`) 让所有 fork 子用**同一个** placeholder tool_result、只有末尾 directive 文本不同，把"前缀字节对齐"做到极致。

**关键辨析(易混点)：fork 继承了能力和上下文、长得像"分身"，但它仍然是子 agent，不是 new 一个主 agent。** 判据是身份/归属没变——它由 `AgentTool` 派生、跑在父的一次工具调用内、结果回传父、`permissionMode:'bubble'` 把审批冒泡给父。代码里甚至写死了这句(`forkSubagent.ts:175`)：

> *"You are a forked worker process. **You are NOT the main agent.**"*

名字借的就是 Unix `fork()`：子进程**拷贝父的整个内存**(地址空间 / fd / 执行状态)，内容上和父一模一样，但它仍是个有独立 PID、从属于父、`exit` 后被父 `wait` 回收的**子进程**，不是新的 init。cc-haha 的 fork 完全是这个语义。

用 §14 的"受约束 / 隔离 / 从属"三词框架看最透：**fork 放松了「隔离」(继承上下文)和「受约束」(全量工具)，却死守「从属」——所以它仍是子 agent。「从属」才是子 agent 的身份证，「隔离」「受约束」只是可调的待遇。**

也正因为 fork 继承了父的 system、会"以为自己是主 agent"，才要 `buildChildMessage`(`:171`) 那段强纪律("你是 fork worker、别再 spawn、别废话、汇报 ≤500 词、开头必须是 'Scope:'")把它掰回 worker 心态。mini-cc 的子 agent 是全新上下文 + 专门的 `SUBAGENT_SYSTEM`，天然就是 worker，不需要这套压制。

### 13. mini-cc 明确简化掉的（知道边界在哪）

| 能力 | cc-haha | mini-cc |
|---|---|---|
| 多 agent / 团队(teammate) | `spawnTeammate`、`name`/`team_name`、`SendMessage` 互相喊话(`AgentTool.tsx:284`) | 无 |
| 后台 agent | `run_in_background` + `<task-notification>` | 无 |
| worktree 隔离 | `isolation` + `buildWorktreeNotice`(`forkSubagent.ts:205`)，子 agent 在独立 git worktree 改文件不污染父 | 无(子 agent 只读，不存在写冲突) |
| 多 agent 类型 | `subagent_type`(general-purpose/Explore/自定义…) + `loadAgentsDir` 从目录加载 | 单一固定子 agent |
| skills 注入 | 子 agent 启动时并发加载 skill 内容进初始 messages(`runAgent.ts:617`) | 无 |
| fork + prompt cache 对齐 | `buildForkedMessages` 字节级对齐 | 无 |

这些都不是"没看懂"，是"mini-cc 的目标是讲透内核(隔离 + 嵌套 loop + 递归防护 + 结果回收)，规模化特性按需略去"。

> ⚠️ **别误读这张表**：`skills 注入`这行说的是 **mini-cc 自己没接 skill 系统**——**不是"子 agent 用不了 skill"**。恰恰相反，cc-haha **专门保证了**子 agent 能用 **MCP(additive)和 skill(预加载)**；mini-cc 唯一的真缺口是因"只读一刀切"漏了 MCP(§6 的债)。为什么子 agent 该保留这些外部能力、以及"可见 ≠ 可执行"的边界，见 **§17**。

---

## 第四部分 · 主 agent vs 子 agent：一张总图

前三部分顺着"实现 → 对照"走，这一部分把散点收口成一个**统一框架**——面试被问"主 / 子到底差在哪"，背这一节就够。

### 14. 统一框架：同一个引擎，三个词

反复坐实过的一件事：**主 agent 和子 agent 跑的是同一个 `runAgent → query` 内核**(真 CC 如此，mini-cc 也如此)。所以它俩的区别**不在"是什么"，在"怎么被调用"**。全部区别收敛成一句话：

> **子 agent = 一次「受约束 + 隔离 + 从属」的 agent 调用。**

- **从属**——谁创建、归谁管、结果给谁(身份层)
- **隔离**——喂什么上下文(上下文层)
- **受约束**——配什么工具 / 权限 / system(能力层)

主 agent 就是"不受约束(全工具)、不隔离(全局上下文)、不从属(用户直接拥有)"的那个顶层调用。记住这三个词，下面整张表都是它的展开。

### 15. 完整对比表（含 fork 这个边界 case）

| 维度 | 主 agent | 子 agent(普通) | fork 子 agent |
|---|---|---|---|
| **【从属】谁创建** | 用户开会话 | 父调 `AgentTool` | 父调 `AgentTool` |
| `isMainThread` | ✅ true | ❌ false | ❌ false |
| 数量 | 通常唯一 | 可多个(fan-out) | 可多个 |
| 生命周期 | 整个会话 | 父的一次工具调用内 | 父的一次工具调用内 |
| 结果给谁 | 直接给用户(流式) | 回传父(`tool_result`) | 回传父 |
| 有无终端 | ✅ 有 | ❌ 无 | ❌ 无 |
| **【隔离】messages** | 用户输入主线 | **全新数组** | **拷贝父上下文** |
| 看得到谁 | 看不到子的中间 | 看不到主对话 | **继承父对话** |
| **【受约束】工具集** | 全量 | 受限子集 | **全量 `['*']`** |
| 能否再派子 agent | ✅ 能 | ❌ 工具集剔除 | ⚠️ 保留工具 + 运行时拦截 |
| system prompt | 完整 | 定制角色 prompt | **继承父 + worker 纪律** |
| 模型 | 主模型 | 可不同 | `inherit` 父 |
| **【相同】引擎** | `runAgent→query` | 同一个 | 同一个 |
| 能用 MCP / skill | ✅ | ✅(additive / 预加载) | ✅ |

**看 fork 这列**：从属类全和普通子 agent 一样(false / 回传父 / 无终端)，隔离类和受约束类却向主 agent 靠拢(继承上下文 / 全量工具)。**这就是 §12 那句"放松②③、死守①"在表里的样子——`isMainThread:false` + 结果回传父，钉死了它的子 agent 身份。**

### 16. 子 agent 能力为何"受约束"（4 个 why）

把"受约束"这一类单独展开——面试常问"为什么不直接把全部能力给子 agent"：

1. **递归防护(硬约束)**：必须砍掉"派生"工具，否则子 agent 再派子 agent、无限套娃。
2. **没有审批通道**：子 agent 跑在工具调用里、身边没有终端能弹 y/n。所以有副作用的能力要么不给(mini-cc 选只读集 → 全自动放行)、要么冒泡给父(cc-haha fork 的 `bubble`)。**能力和"这能力怎么审批"是绑死的——不能给一个无法审批的能力。**
3. **职责单一**：子 agent 是来干一件具体活的(如调研)，给全套能力反而偏离目的、增加跑偏风险(Explore agent 就纯只读)。
4. **最小攻击面**：子 agent 处理的内容可能混着不可信输入(读到的网页 / 文件里的注入指令)，能力越窄、被带偏能造成的破坏越小。

> **一个必须分清的层次：可见 ≠ 可执行。** 就算工具对子 agent 可见，有副作用的那次调用**仍要过权限门**(D6 的 `passthrough` → 规则引擎)。"保留能力" ≠ "放弃管控"。

### 17. 子 agent 的外部能力：MCP / skill 不被砍（纠一个常见误解）

很容易误以为"子 agent 是阉割版，用不了 MCP / skill"。**错。真 CC 专门保证了子 agent 能用，三处证据：**

- **MCP 工具优先放行**：`filterToolsForAgent` 第一道闸就是 `mcp__` 前缀 `return true`(`agentToolUtils.ts:83`)，**先于所有禁用名单**——不管怎么裁，MCP 工具永远在。
- **MCP server 对父 additive**：`runAgent.ts:648` "additive to parent's servers"——子 agent **继承父的全部 MCP server、还能再加自己的**。是加法，不是减法。
- **skill 主动预加载**：子 agent 启动时把指定 skill 内容并发拉取、塞进它的初始 messages(`runAgent.ts:617`)。

**为什么这么设计？** 因为 MCP / skill 是用户**主动赋予**的能力，性质不同于内置工具——你接 GitHub MCP、装代码索引 skill，本就想让 agent(**包括它派出的子 agent**)能用；而子 agent 最典型的用途(调研某代码库)恰恰**最需要**这些。**裁剪要精准：砍该砍的(派生工具防递归、危险写操作)，保用户赋予的(MCP / skill)。一刀切才是"负向优化"的根源。**

> **mini-cc 的债**：`selectSubagentTools` 的 `t.readOnly` 一刀切会误伤 `readOnly:false` 的 MCP 工具(calc)，导致 mini-cc 子 agent 用不了 MCP(§6)。正确改法是对齐 cc-haha 的 :83，给 MCP 开绿色通道：
> ```ts
> filter((t) => (t.readOnly || t.name.startsWith("mcp__")) && t.name !== "task")
> ```

---

## 第五部分：本次主要代码 diff（m6 → m7）

D7 和前几站不同——不是"在 m(n-1) 上加几处"，而是一次**重构**：把 inline loop 抽出去，m7 退化成壳。三块改动：

### ① 新增 `src/agent.ts`：inline loop → 可注入的 `runAgent`

m6 是顶层 while + 写死的外壳；agent.ts 是同一段 loop，但外壳全变参数：

```diff
- // m6.ts：顶层 while，外壳写死
- while (true) {
-   const stream = client.messages.stream({ model, system: SYSTEM, tools: toolSchemas, ... })
-   stream.on("text", (d) => process.stdout.write(d))         // 写死 stdout
-   ...
-   if (decision === "ask") {
-     const ok = await askApproval(`❓ 允许执行 ${b.name}…`)   // 写死交互
-   }
-   const out = await tool.execute(b.input, ac.signal)        // 写死 ac
- }

+ // agent.ts：可复用函数，外壳注入
+ export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
+   const { client, model, system, tools, approve, onText, signal } = opts
+   while (true) {
+     const stream = client.messages.stream({ model, system, tools: toolSchemas, ... }, { signal })
+     if (onText) stream.on("text", (d) => onText(d))          // 注入
+     ...
+     if (decision === "ask") {
+       const ok = await approve(tool, b.input, brief)         // 注入
+     }
+     const out = await tool.execute(b.input, signal)          // 注入
+   }
+   return { text: lastText(last), usage, turns, stopReason, aborted }
+ }
```

### ② 新增 `src/task.ts`：`makeTaskTool` + `selectSubagentTools`（见 §5、§6，递归防护一行是核心）

### ③ `m6.ts` → `m7.ts`：inline loop 整段删除，换成一次 `runAgent` 调用

```diff
  const allTools = [...builtinTools, ...mcpTools]
+ const taskTool = makeTaskTool({ client, model: MODEL, parentTools: allTools })  // 新增
+ const allWithTask = [...allTools, taskTool]
  // ... 键盘监听 / askApproval 保留在壳里 ...

- let turn = 0
- while (true) {            // ← m6 的整段 inline loop（约 70 行）全部删除
-   const stream = client.messages.stream(...)
-   ... 权限门 / 执行 / 回填 / 压缩 ...
- }

+ const result = await runAgent({            // ← 换成一次调用，外壳走回调
+   client, model: MODEL, system: SYSTEM, tools: allWithTask, messages,
+   approve: (tool, _i, brief) => askApproval(`❓ 允许执行 ${tool.name} ${brief}？…`),
+   onText: (d) => process.stdout.write(d),
+   signal: ac.signal, label: "main", verbose: true,
+ })
```

净效果：**loop 逻辑只剩一份(在 agent.ts)，主/子共用**。这正是 §3 那句"子 agent 倒逼 loop 抽象"落到代码上的样子。

---

## 第六部分：面试金句

1. **"子 agent 是什么"** —— 主 agent 在一次工具调用里派生一个带独立上下文的子 agent，子 agent 干完只回传一段结论，中间过程留在子上下文用完即弃。一句话：**把"高消耗、只需结论"的活外包，省主上下文**。

2. **"子 agent 最难的地方不是子 agent"** —— 是它**倒逼你把 agent loop 抽成可复用、可嵌套的函数**。主 agent 和子 agent 必须共用同一个 loop 内核(真 CC 的 AgentTool 也调同源 runAgent)。能讲出"子 agent 成立 = loop 抽象成立"，就说明你看懂了内核。

3. **"上下文隔离不是魔法"** —— 就是子 agent 用一条全新的 messages 数组。我有端到端账单为证：子 agent 读两个上百行文件(token 落在子上下文)，主 agent 全程不沾文件全文。

4. **"递归防护就一行 filter，半个条件是关键"** —— `t.readOnly && t.name !== "task"`。task 工具自己也只读，不显式剔除它，子 agent 就能无限递归派生。真 CC 对一般子 agent 也走这条(工具集剔除 Agent)，只有 fork 子 agent 为了 cache 对齐才保留工具、改用运行时检测。

5. **"注册表正交，再次兑现"** —— 主 loop 眼里 task 和 read_file 没区别，都是 toolMap 里一个有 execute 的对象。D6 把 MCP 工具这么塞，D7 把整个子 agent 这么塞，loop 和权限门一行没改。

6. **(主动暴露边界)** —— mini-cc 的结果回收没做"末条是纯 tool_use 时往前找 text"的 fallback(真 CC `finalizeAgentTool` 有)；也没做 fork 模式、多 agent、后台、worktree 隔离。这些是规模化特性，不是内核。

7. **"fork 是子 agent，不是新主 agent"**(高频辨析陷阱) —— fork 继承父的上下文 + 全量工具、长得像分身，但它由 `AgentTool` 派生、结果回传父、`isMainThread:false`，代码里写死 "You are NOT the main agent"。名字借 Unix `fork()`：拷贝父内存的子进程仍是子进程，不是新 init。

8. **"一个框架收口主 vs 子"** —— 子 agent = 一次「受约束 + 隔离 + 从属」的调用。**从属是身份证(不可放松)，隔离与受约束是待遇(可调)**——fork 就是放松了后两者、死守从属，所以仍是子 agent。

9. **"子 agent 照样能用 MCP / skill，负向优化的根源是一刀切"** —— 真 CC 让 MCP 优先于禁用名单放行、server 对父 additive、skill 预加载。裁剪要精准：砍该砍的(派生工具 / 危险写)，保用户主动赋予的(MCP / skill)。我 mini-cc 这块欠了债(只读一刀切误伤 MCP)，正好能讲"我知道边界在哪、也知道怎么补"。
