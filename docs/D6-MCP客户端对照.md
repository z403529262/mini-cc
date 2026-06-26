# D6 — MCP 客户端对照（mini-cc 手写 ↔ cc-haha 真身）

> 双线螺旋第六关：先手写最小 MCP 客户端跑通，再解剖 cc-haha 的真实实现，最后提炼面试话术。
> 阅读约定同前：每节先讲「是什么 / 为什么」，再讲「怎么做」。

---

## §0 这一关在解决什么

mini-cc 到 M5 为止，工具全是**硬编码**的（`tools.ts` 里 6 个）。
**MCP（Model Context Protocol）** 是 Anthropic 定的「给 agent 接外部工具」的标准协议：
agent 运行时连上一个独立进程（MCP server），问它「有哪些工具」（`tools/list`）、再调用（`tools/call`）。
你在 Claude Code 里看到的那一堆 `mcp__chrome__*`、`mcp__playwright__*` 工具，全是这么来的。

**为什么这关重要（面试视角）**：它考的不是"会不会用 MCP"，而是**"加一类全新的工具来源，要不要动调度逻辑"**。
答案应该是：不动。M6 的核心成果是——MCP 工具被包装成本地 `Tool` 塞进 `toolMap`，**agent loop 和权限门一行都没改**。
这就是「注册表 + 权限门」正交设计的回报。

---

# 第一部分：mini-cc 怎么做（手写吃透协议）

## §1 MCP 是什么 / 为什么这么设计

**是什么**——三件套（我两端都手写了，所以吃透了）：
1. **stdio 分帧**：一条消息 = 一行 JSON，`\n` 分隔，消息内禁裸换行；stdout 只放合法消息，**日志走 stderr**（否则污染数据通道）。
2. **握手**：`initialize`（协商 protocolVersion / capabilities）→ `notifications/initialized`（无 id 的通知）→ 可以干活。
3. **发现 + 调用**：`tools/list` 报菜单、`tools/call` 点菜。

**为什么这么设计**：
- **进程隔离**：外部工具崩了不拖垮 agent（独立子进程）。
- **语言无关**：server 用任何语言写都能接（只认 stdio + JSON-RPC 这个最小公约数）。
- **标准化**：一套协议接万物，不必为每个集成写一遍胶水。
- 代价：多一跳 IPC + 序列化开销。

## §2 协议手写（`src/mcp.ts` + `demo/mcp-server-calc.ts`）

`MCPClient`（`src/mcp.ts`）的骨架：
- `Bun.spawn` 起 server 子进程（stdin 我们写、stdout 我们读、stderr 收日志）。
- `readLoop()`：从 stdout 按 `\n` 分帧、逐行 `JSON.parse`。**必须在发第一个请求前就跑起来**（否则响应丢）。
- `pending: Map<id, {resolve,reject}>` + 自增 `idSeq`：`request()` 发请求挂一个 Promise，`onLine()` 收到响应按 `id` 回 resolve。带 10s 超时兜底。
- `notify()`：发无 id 的通知（用于 `notifications/initialized`）。
- `connect()`：`initialize` → `notify("notifications/initialized")` → `tools/list`，返回工具清单。
- `close()`：关 stdin → 等子进程退出（stdio shutdown 顺序）。

**错误二分**（spec 的关键设计，我两条都实现了）：
- **协议错误**（未知工具、参数 schema 不符）→ JSON-RPC `error` 字段 → client `reject`。
- **工具执行错误**（业务失败，如参数非法）→ `result.isError: true` → 不是 reject，是带 `isError` 的正常响应。
`demo/mcp-server-calc.ts` 故意区分了这两类（未知工具走 error，参数非数字走 isError）。

## §3 `toTools()` —— 把 MCP 工具变成本地 Tool（正交性的关键）

```
MCP tool  →  { name: mcp__calc__add, readOnly:false, input_schema, execute }  →  toolMap  →  loop 照常跑
```
要点：
- **命名加前缀** `mcp__${server}__${tool}`：防与内置工具 / 别的 server 撞名（照搬真 CC 命名）。
- **字段转换**：MCP 用 camelCase 的 `inputSchema`，我们 `Tool` 接口用 snake 的 `input_schema` —— `toTools` 是这个转换点。
- **execute**：调 `tools/call` → 拼 `result.content[]` 里的 text；`isError` → 加 `[MCP 错误]` 前缀**回填**（不抛，让模型换方案，风格同内置工具）。

`src/m6.ts` 相对 `m5.ts` 只多三处：①loop 前连 MCP、合并工具表 ②开场提示带上 MCP 工具 ③收尾 `close`。
**loop 主体逐字未动** —— 这就是 D6 要证明的。

**m6 ← m5 的实质 diff**（`src/mcp.ts`/`demo/mcp-server-calc.ts`/`demo/mcp-check.ts` 是全新文件；这里只看对主循环的*修改*。注释/措辞略，完整逐行见 `diff src/m5.ts src/m6.ts`）：

```diff
 import Anthropic from "@anthropic-ai/sdk"
 import readline from "node:readline"
-import { tools, toolMap } from "./tools"
+import { join } from "node:path"
+import { tools as builtinTools, type Tool } from "./tools"   // ① 不再 import 固定 toolMap
 import { compact, estimateTokens } from "./compact"
 import { checkPermission } from "./permission"
+import { MCPClient } from "./mcp"

-// ② m5：toolSchemas 在文件顶部，直接从固定的 6 个 tools 算
-const toolSchemas = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))

 const task = process.argv.slice(2).join(" ") || "用 calc 工具算 (2+3)*4 …"

+// ③ M6 核心：先连 MCP、合并工具，之后才建 toolMap / toolSchemas（构建时机随之后移）
+const mcp = new MCPClient(["bun", "run", join(import.meta.dir, "../demo/mcp-server-calc.ts")])
+let mcpTools: Tool[] = []
+try { await mcp.connect(); mcpTools = mcp.toTools("calc") }
+catch (e) { /* 连不上 → 降级为只用内置工具，不拖垮 agent */ }
+const allTools = [...builtinTools, ...mcpTools]
+const toolMap = new Map(allTools.map((t) => [t.name, t]))
+const toolSchemas = allTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))

+// ④ 非交互开关（真 CC acceptEdits/dontAsk 雏形）
+const AUTO_APPROVE = process.env.AUTO_APPROVE === "1"
 function askApproval(prompt) {
+  if (AUTO_APPROVE) return Promise.resolve(true)
   ...
 }

   // ===== while 循环体：toolMap.get(name) → checkPermission → execute，逐字未改 =====

+await mcp.close().catch(() => {})   // ⑤ 收尾：优雅关 server 子进程
 process.exit(0)
```

**读法**：实质就 ①②③④⑤ 五处，**全在 loop 外**；`while` 循环体一行没动 —— 这就是「注册表 + 权限门」正交的证据。其中 ②③ 是同一件事的两面：工具表来源从「固定 6 个」变成「内置 + MCP 合并」，所以**构建时机也从文件顶部挪到了 `connect()` 之后**（toolMap/toolSchemas 依赖运行时才知道的 MCP 工具）。

## §4 权限：MCP 工具 = 不可信外部输入

mini-cc 把 MCP 工具一律设 `readOnly: false` → 落到 `checkPermission` 的 `ask` 分支。
**故意不读 server 给的 `annotations.readOnlyHint`**，依据是 spec 原文：
> clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers.

于是 M5 的权限门**零改动**就覆盖了 MCP 工具（端到端实测：模型调 `mcp__calc__add` 时弹了 ask）。

## §5 验证

- 协议层 `demo/mcp-check.ts`：6 断言全绿（握手发现 / 命名前缀 / readOnly=false / add=5 / multiply=20 / isError 回填）。
- 集成层 `src/m6.ts`：真 LLM（glm-4.6）自主调 `mcp__calc__add(2,3)=5` → `mcp__calc__multiply(5,4)=20` → 答 20，cache 命中 66%（M4 继续工作）。

---

# 第二部分：cc-haha 怎么做（解剖真身）

> 一句话总览：**mini-cc 手写协议 100 行；cc-haha 用官方 SDK，把精力全花在「集成、健壮、安全」上。**

## 能力全景图：cc-haha 支持哪些 MCP 能力（先看这张 · case-by-case）

> mini-cc 只接了 MCP 的 **tools** 一个维度，还把它压平成本地 `Tool`。但 MCP 远不止工具——
> 理解能力的钥匙是**方向**（谁在用谁）。cc-haha 的 client 握手时只声明 `roots:{}` + `elicitation:{}`（client.ts:990）；
> server 侧能力连上后用 `getServerCapabilities()`（:1153）按需探测。

**方向①：CC 消费 server**（client→server，主流）

| 能力 | 是什么 | cc-haha 实现 | case |
|---|---|---|---|
| **tools** | 调用 server 的动作（有副作用） | 探测 `capabilities.tools`(:1744) → 注册成 `mcp__server__tool` | Playwright MCP 暴露 `mcp__playwright__click`，模型当普通工具调 |
| **resources** | 读 server 的**被动数据** | 探测(:2000) → `resources/list`(:2005) + `resources/read`(ReadMcpResourceTool:97)；专门工具 List/ReadMcpResourcesTool | DB server 把表结构暴露成 `db://schema/users`，模型**读它**了解 schema，而非调工具查 |
| **prompts** | 取 server 预设的**指令模板** | 探测(:2033) → `prompts/list`(:2039) + `getPrompt`(:2072)；**转成 slash command**(:2053 命名 `mcp__server__prompt`) | review server 提供 `/server:review <file>`，打斜杠命令即展开预设 prompt |

> 三者区别（高频考点）：**tools=做动作 / resources=读数据（被动拉）/ prompts=预设指令模板（变斜杠命令）**。都是 server 提供、CC 消费。

**方向②：server 反向调 CC**（server→client，反向通道）

| 能力 | 是什么 | cc-haha 实现 | case |
|---|---|---|---|
| **roots** | server 反问"你能访问哪些目录" | 声明(:991) + handler 返回 `file://${cwd}`(:1005) | filesystem server 问 CC 根目录，CC 回当前 cwd，server 据此**限定可访问范围** |
| **elicitation** | server 执行中**反向问用户** | 声明(:995) + `ElicitRequestSchema` handler(:1187，初始化期先返 `cancel` 兜底，连上后 `registerElicitationHandler` 覆盖成真弹窗 `ElicitationDialog.tsx`) | 部署 server 中途弹"确认部署到 production?"，CC 弹窗收集输入再回传 |
| **sampling** ❌ | server **借用 CC 的 LLM** 做子推理 | **client 未声明**(:990 仅 roots/elicitation)，无 `CreateMessageRequestSchema` handler | 翻译 server 想"借你的 Claude 翻译这段"——cc-haha **不支持**。why：外部 server 白嫖你的模型额度 + 可借上下文做注入，安全/成本双风险 |

**方向③：通知**（单向 server→client，热更新）

| 能力 | cc-haha 实现 | case |
|---|---|---|
| **\*/list_changed** | tools/prompts/resources 三种(useManageMCPConnections:624/673/711) → 不重启刷新 | server 登录后解锁更多工具，发 `tools/list_changed`，CC 当场刷新、无需重连 |
| **experimental（自定义）** | `capabilities.experimental['claude/channel/permission']`（channelPermissions.ts，详见 §11） | 用 experimental 字段塞协议外的自定义能力（审批转手机） |

**未实现**：`logging`（`logging/setLevel`）、`completions`（`completion/complete`，prompt 参数补全）—— cc-haha 没接。

**一个互操作踩坑**：client capabilities 故意发空 `{}` 而非 `{form:{},url:{}}`（client.ts:992）——因为 **Java MCP SDK（Spring AI）的 Elicitation 类零字段、遇未知属性报错**。多语言协议，字段多写一个都能炸别人。

> **一句话框架**：MCP 能力分三方向——**CC 消费 server**(tools/resources/prompts)、**server 反向调 CC**(roots/elicitation/sampling)、**通知热更新**(list_changed)。cc-haha 开了前两类大部分，**唯独 sampling 不开**（不让外部 server 借你的模型），logging/completions 没接。

---

## §6 transport：官方 SDK + 5 种通道

cc-haha 不手写协议，直接用 `@modelcontextprotocol/sdk`。`services/mcp/client.ts` 里实例化了 **5 种 transport**：

| transport | 用途 | 锚点 |
|---|---|---|
| `StdioClientTransport` | 本地子进程 server（= mini-cc 手写的那种） | client.ts:946 |
| `SSEClientTransport` | 远程 SSE（旧版远程协议） | :670 / :699 |
| `StreamableHTTPClientTransport` | 远程 HTTP（2025 spec 新版） | :858 / :897 |
| `WebSocketTransport` | 自定义 WS（`utils/mcpWebSocketTransport.ts`） | :731 / :780 |
| `InProcessTransport` / `SdkControlClientTransport` | 进程内（linked pair，用于 SDK / IDE 内嵌） | :918 / :937 |

握手由 SDK 封装：`new Client(...)`（:981）带 `capabilities`（:990）→ `client.connect(transport)`（:1044）自动走 initialize。
**我手写的 initialize/initialized/分帧/id 匹配，SDK 全替你做了** —— 这正是"手写吃透 vs 用库省事"的分野。

## §7 工具注册：空壳 + 运行时覆盖

`tools/MCPTool/MCPTool.ts` 是个 **空壳模板**：`name:'mcp'`、`call()` 返空、`description` 占位，注释反复写 `// Overridden in mcpClient.ts`。
真正的注册在 `client.ts:1764-1770`：
```ts
const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
return {
  ...MCPTool,                                   // 摊开空壳
  name: skipPrefix ? tool.name : fullyQualifiedName,  // 覆盖真名
  mcpInfo: { serverName: client.name, toolName: tool.name },  // 挂元信息（权限检查用）
  async call(...) { /* 真正调 callTool */ },     // 覆盖执行体
  userFacingName() { return tool.annotations?.title || tool.name },  // 显示名优先用 annotations.title
}
```
对照 mini-cc：我用 `map` 直接造对象，cc-haha 用 `{...空壳, 覆盖}` —— **同一思路（适配成统一 Tool 形状），不同手法**。

**命名比 mini-cc 多了 normalize**（`mcpStringUtils.ts:50` + `normalization.ts:17`）：
```ts
buildMcpToolName = `mcp__` + normalizeNameForMCP(server) + `__` + normalizeNameForMCP(tool)
normalizeNameForMCP(name) = name.replace(/[^a-zA-Z0-9_-]/g, '_')  // 非法字符→下划线
```
**为什么必须 normalize**：Anthropic API 的 tool name 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`，
而 server 名常含非法字符（`@scope/pkg`、`claude-in-chrome`、`.`）。**mini-cc 漏了这步**（见 §15 待补）。

**`skipPrefix`（:1757）高级玩法**：仅当 `config.type==='sdk'` 且环境变量 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` 为真，
MCP 工具用**原名**（不加 `mcp__` 前缀），从而能**按名覆盖内置工具**；权限检查仍走 `mcpInfo`。

## §8 执行 / 错误：callTool + isError + 重试

- 执行：`client.callTool(..., CallToolResultSchema, ...)`（:3087）—— SDK 带 schema 校验。
- 错误：`if ('isError' in result && result.isError)`（:3119）→ **抛专门的 error 类**（:173，携带 `result._meta`）。
  对照 mini-cc：我把 isError **软回填成文本**让模型重试；cc-haha **抛异常**让上层统一 catch + UI 展示 + 携带元信息。两种都对，mini-cc 的更适合"回填给模型"。
- **比 mini-cc 多的健壮性**：
  - URL elicitation 重试（`callMCPToolWithUrlElicitationRetry` :1859）—— server 可反向要求用户补信息。
  - session recovery 重试（:1915）—— 连接断了自动恢复重试。
  - onclose 时 **reject 所有 pending callTool**（:1231 / :3208）—— 否则连接断了 `await callTool()` 永久挂起（mini-cc 只做了单请求超时，没做 onclose 批量 reject）。

## §9 权限：passthrough → 统一规则引擎（呼应 D5）

`MCPTool.checkPermissions` 返回 `behavior:'passthrough'`（MCPTool.ts:56-61）——
**MCP 工具不自己判权限**，透传给 D5 那套统一规则引擎。规则按 `mcp__server__tool` 匹配（`permissions.ts:236-259`）：
- server 级：规则 `mcp__server1` 匹配该 server **所有**工具。
- 单工具：规则 `mcp__server1__tool1` 精确匹配。
- 通配：规则 `mcp__server1__*` 匹配 server1 全部工具。
- 走的还是 D5 的 `getDenyRuleForTool`（:287）→ `checkRuleBasedPermissions`（:1071），**deny > allow > ask 优先级链**。

**关键对照**：
- mini-cc：靠「工具自报 `readOnly`」决定过不过门（粗，但够用）。
- cc-haha：靠「工具 `passthrough` + 用户可配规则」决定（细，用户能 allow `mcp__calc__add`、deny `mcp__shell__*`）。
- 共同点：**MCP 工具都不自决，交给统一权限门**。这是两边都对的核心原则。

## §10 多 server + 健壮性（mini-cc 完全没做）

- `MCPConnectionManager.tsx` + `useManageMCPConnections.ts`：管理**多个** server 的生命周期（mini-cc 只连 1 个）。
- 连接超时（:1058）、reconnect（`components/mcp/MCPReconnect.tsx`）、connectivity 状态（`hooks/notifs/useMcpConnectivityStatus.tsx`）。
- OAuth 认证（`services/mcp/auth.ts`、`McpAuthTool`）—— 远程 server 要登录。
- 配置（`services/mcp/config.ts`、`commands/mcp/addCommand.ts`）—— `.mcp.json` 多源合并 + UI 审批对话框（`MCPServerApprovalDialog.tsx`）。

## §11 意外宝藏：MCP 不止接工具，还能当「审批通道」

`services/mcp/channelPermissions.ts` —— MCP server 还能是 **channel**（Telegram / iMessage / Discord）：
CC 把权限审批 prompt **转发到你手机**，你回 `yes tbxkq`（5 个字母的短 ID，`PERMISSION_REPLY_RE` :75），
server 解析成**结构化事件**回来（不是文本）。
**安全设计很精彩**（注释里 Kenneth 的 "would this let Claude self-approve?"）：
- 批准方是「人通过 channel」，不是 Claude。
- CC **不 regex 匹配回复文本**，而要求 server 主动 emit `notifications/claude/channel/permission` 结构化事件 —— 防止 general channel 里的普通文本意外批准。
- 短 ID 还有脏词黑名单（`ID_AVOID_SUBSTRINGS`）+ 去 'l'（像 1/I）—— 怕随机 5 字母拼出尴尬词发到你老板手机。
这说明 MCP 的 capabilities 协商是可扩展的（`experimental['claude/channel/permission']` 是 server 显式 opt-in）。

---

# 第三部分：对照与面试

## §12 mini-cc ↔ cc-haha 对照表

| 维度 | mini-cc（手写） | cc-haha（真身） |
|---|---|---|
| 协议 | 手写 stdio JSON-RPC（~100 行，吃透分帧/握手/id 匹配） | `@modelcontextprotocol/sdk` 封装 |
| transport | stdio only | Stdio / SSE / StreamableHTTP / WebSocket / InProcess **5 种** |
| 工具适配 | `toTools()` map 造对象 | `MCPTool` 空壳 + 运行时 `{...覆盖}` |
| 命名 | `mcp__${server}__${tool}` | 同 + `normalizeNameForMCP`（非法字符→`_`）+ skipPrefix 高级玩法 |
| 执行错误 | `isError` → `[MCP 错误]` 软回填 | `isError` → 抛 error 类（带 _meta）+ elicitation/recovery 重试 |
| 权限 | `readOnly:false` → 落 ask 分支 | `passthrough` → 规则引擎 `mcp__server__tool`（server级/通配，复用 D5 链） |
| 多 server | 只连 1 个 | ConnectionManager 管多个 + reconnect + OAuth + UI 审批 |
| 连接健壮 | 单请求 10s 超时 | 连接超时 + onclose 批量 reject pending + session recovery |
| 关闭 | 关 stdin → 等退出 | 同（SDK transport.close） |

## §13 面试金句

1. **"好的抽象，让『加一类全新的工具来源』变成『往注册表里多塞几个对象』，而不是改调度逻辑。"** —— m6 相对 m5，loop 一行没改。
2. **"MCP 工具是不可信外部输入，权限门必须覆盖它，且默认从严。"** —— mini-cc 不信 `readOnlyHint`；cc-haha 让它 `passthrough` 给规则引擎。spec 原文 "annotations untrusted unless trusted server"。
3. **"错误要分两层：协议错误（reject）和工具执行错误（isError）。"** —— 后者不该让一个工具崩掉整个 loop。
4. **"手写一遍协议是为了吃透；生产用 SDK 是为了把精力花在集成/健壮/安全上。"** —— 5 种 transport、reconnect、OAuth、onclose reject pending，这些才是真 CC 的工作量。
5. **"命名前缀 `mcp__server__tool` 不只是防撞名，还是权限规则的匹配键。"** —— `mcp__server`（server 级）、`mcp__server__*`（通配）直接是 deny/allow 规则。

## §14 源码锚点

**mini-cc**：`src/mcp.ts`（MCPClient / readLoop / onLine / request / connect / toTools / close）、`demo/mcp-server-calc.ts`、`demo/mcp-check.ts`、`src/m6.ts`（连接段 + loop 不变）。

**cc-haha**：
- 客户端核心 `services/mcp/client.ts`：transport 实例化（SSE:670/699、WS:731/780、StreamableHTTP:858/897、InProcess:918/937、Stdio:946）、握手（new Client:981 / capabilities:990 / connect:1044）、工具注册（skipPrefix:1757 / buildMcpToolName:1764 / {...MCPTool}:1766 / name:1769 / mcpInfo:1770 / call:1829 / elicitation重试:1859 / userFacingName:1968 / prompts mcp__:2053）、执行（callTool:3087 / CallToolResultSchema:3093 / isError:3119）、onclose reject pending（1231 / 3208）。
- 能力地图（§全景图）`services/mcp/client.ts`：capabilities 声明 roots/elicitation(:990) / ListRoots handler(:1005) / getServerCapabilities 探测(:1153) / Elicit handler(:1187) / resources/list(:2005) / prompts/list+getPrompt(:2039+:2068)；resources 工具 `ReadMcpResourceTool:97` + `ListMcpResourcesTool`；list_changed 热刷新 `useManageMCPConnections:624/673/711`。
- 工具空壳 `tools/MCPTool/MCPTool.ts`（isMcp:28 / name:'mcp':34 / checkPermissions passthrough:56-61）。
- 命名 `services/mcp/mcpStringUtils.ts:50`（buildMcpToolName）+ `services/mcp/normalization.ts:17`（normalizeNameForMCP）。
- 权限 `utils/permissions/permissions.ts`（mcp__ 匹配注释:236-259 / getDenyRuleForTool:287 / checkRuleBasedPermissions:1071）。
- 多 server `services/mcp/MCPConnectionManager.tsx`、`useManageMCPConnections.ts`、`config.ts`、`auth.ts`。
- 审批通道 `services/mcp/channelPermissions.ts`（PERMISSION_REPLY_RE:75 / shortRequestId:140 / filterPermissionRelayClients:177）。
- transport 文件 `utils/mcpWebSocketTransport.ts`、`services/mcp/InProcessTransport.ts`、`SdkControlTransport.ts`。

## §15 mini-cc 待补（可作为后续 M6+ 增强）

- **server 名 normalize**（真缺陷）：现在 `mcp__${serverName}__` 直接拼，若 serverName 含 `@./-空格` 会被 Anthropic API 拒。应照 `normalizeNameForMCP` 替换非法字符。
- 多 server 连接管理（现在只连 1 个 stdio server）。
- `onclose` 批量 reject pending（现在只有单请求超时；连接突然断，其它 pending 要等到各自超时）。
- 远程 transport（SSE / StreamableHTTP）+ OAuth 认证。
- 用户可配权限规则（现在 MCP 一律 ask；应支持 allow `mcp__calc__*` 这类规则，对接 D5 的规则引擎）。
- **接其它 MCP 能力维度**（mini-cc 现在只接了 tools，见上方「能力全景图」）：resources（`resources/list`+`resources/read`，读 server 被动数据）、prompts（转 slash command）、roots（告诉 server 文件根）、elicitation（server 反向问用户）、`*/list_changed` 通知（热刷新工具表）。

---

# 第四部分：深挖答疑（换会话后的追问沉淀）

> 体例同 D4/D5 文档第四部分。这几节是把"MCP 到底比『一堆工具』多了什么"追到底的产物。

## §16 MCP prompts —— tools 之外，另一种「给用户用」的能力

**是什么**：server 预设的**参数化提示词模板**，在 CC 里暴露成 slash command `/server:prompt`。

**与 tools 的本质区别**（理解点）：

| | 谁触发 | 给谁用 |
|---|---|---|
| **tools** | **模型**自己决定调（model-controlled） | 模型的"能力" |
| **prompts** | **用户**主动从 `/` 菜单选（user-controlled） | 用户的"快捷指令" |

**关键**：prompt 内容是 **server 在 `prompts/get` 时动态返回的**（cc-haha `getPromptForCommand` → `client.getPrompt({name,arguments})`，client.ts:2068，用的是 server 当场返回的 `result.messages`，不是本地静态文件）。所以 server 能在你触发的瞬间**注入实时数据**。

**case**：GitHub `/github:summarize_pr 1234`（server 端实时拉 PR diff + 按规范总结）、Sentry `/sentry:analyze_issue <id>`、DB `/db:explain_schema`。
**场景特征**：重复的、结构化的、套路固定的长指令 → 打包成一键命令。
**现实**：prompts 用得少，绝大多数 server 只做 tools。

## §17 MCP prompt vs skill —— 为什么上面那几个是 prompt 不是 skill

**先戳破前提**：它们**都能**做成 skill；真正的问题是何时适合哪个。

| 维度 | MCP prompt | skill |
|---|---|---|
| 谁拥有/维护 | 第三方 server 提供方（GitHub 官方） | **你/你团队**，在本地文件系统 |
| 内容怎么来 | server 在 `prompts/get` **动态生成** | 静态 `SKILL.md`（+ 可选脚本） |
| 绑外部系统 | 跟该 server 的 tools/认证**同源打包** | 本地的，自己不带连接 |
| 方向 | **供给侧**：服务方标准化推给所有用户 | **需求侧**：使用方自己定制 |

**那三个适合 prompt 的原因**：① server 动态生成能注入实时数据；② 都绑外部系统 + 认证，而你为了用它的 tools 已经连了那个 server，prompt 跟 tools 同源一次性分发；③ 供给侧——GitHub 想给所有人一套标准 PR 总结流程。

**何时该 skill**：纯本地 / 私有 / 静态 / 不绑外部服务（例：用户自己的 `stock-research-report` skill）。

**判断口诀**：
> 这段工作流**要不要连某个外部系统、要不要它的实时数据/认证**？
> 要 → 它自然属于那个系统的 MCP server（和 tools 打包，服务方维护）；
> 纯本地/私有/静态 → skill（你自己维护）。

**诚实补刀**：现实里 **skill 更流行**（一个 md 文件、不用跑 server，Anthropic 自己也大量用）。那几个例子换成 skill + `gh` CLI 完全可行——区别只在**归属和打包**，不是"必须 MCP"。

## §18 实测：本机当前会话在用哪些 MCP、用了什么能力

盘点这个 Claude Code 会话连着的 MCP（按 `mcp__*` 工具归类）：

| MCP server | 干什么 | 能力 |
|---|---|---|
| andromeld | 控制 Android 手机 | tools |
| computer-use | 控制 macOS 桌面 | tools |
| Claude_in_Chrome | 浏览器自动化 | tools |
| Claude_Preview | dev server 预览调试 | tools |
| context7 | 查库的最新文档 | tools |
| visualize | 生成可视化 widget | tools |
| scheduled-tasks | 定时任务 / cron | tools |
| mcp-registry | 搜索/列出可装的 connector | tools |
| ccd_session / ccd_session_mgmt / ccd_directory | 会话 / 跨会话 / 目录操作 | tools |
| codegraph | 代码图谱（本会话**未激活**，无 `.codegraph/`） | — |

**结论：清一色 `tools`，零 `resources`、零 `prompts`。** resources 可坐实——若有 server 启用它，CC 会注入 `ListMcpResourcesTool` / `ReadMcpResourceTool` 两个工具，而当前工具列表里没有这俩。

**why**：在用的这些全是**「动作执行型」**（控手机/浏览器/桌面、检索、调度、可视化），天然就是 tools；prompts 属于**「指令模板型」**server（GitHub/Sentry/Jira 那类），没装这类，所以从没碰过 prompts。**这正好印证 §全景图：tools 是 ~95% 的真实用例。**
