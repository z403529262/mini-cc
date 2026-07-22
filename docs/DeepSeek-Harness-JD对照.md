# DeepSeek「Agent Harness 研发工程师」JD 对照清单

> 用途:简历包装、项目介绍话术、面试举例的**共同底稿**。JD 的每条要求,对应到 mini-cc 里可直接讲的产出 + 实测数字。
> 岗位信息(2026-06 核实):Harness 代码智能体团队,工程岗,本科+,年薪 45W-98W(14薪),北京。职责=将 Agent 研究方案落地:工具调用、沙箱执行、终端交互、长记忆底层服务。技术栈=后端开发、LLM API、上下文缓存、文件/终端执行环境。加分项=IDE 插件、代码沙箱、RAG 服务、多轮对话系统;重度使用 Claude Code/Cursor 等 AI 编程工具优先。
> 投递渠道:deepseek.com 官网 / 短链 t.cn/AXisN0RS / 猎聘 / BOSS直聘。社招常年滚动,非限时窗口。

---

## 一、JD 要求 → mini-cc 产出逐条对照

### 1. 工具调用(JD 职责原文)

| 项 | 内容 |
|---|---|
| 对应产出 | M2 工具注册表 `src/tools.ts` + 6 工具(read/write/edit/glob/grep/bash) |
| 硬数字 | `edit_file` 唯一性检查算法 `split(x).length-1` **与真 CC(cc-haha 44万行复刻)完全一致**;实测并行工具调用(一轮 3 个 read_file 同一条 user 消息回填) |
| 深度弹药 | 解剖 cc-haha FileEditTool 1500+ 行 vs 我 23 行:官方外包的六层(schema/描述/校验/容错/原子写/IDE)+ 硬核暗坑(TOCTOU 读后被改检测、desanitize、弯引号归一化) |
| 一句话术 | "工具=给模型看的说明书(input_schema)+给代码用的执行体(execute),加进数组就能用——MCP 工具和整个子 agent 都是包装成这个形状塞进数组接入的,loop 零改动。" |
| 详见 | `docs/D2-工具系统与文件编辑对照.md` |

### 2. 沙箱执行(JD 职责原文)

| 项 | 内容 |
|---|---|
| 对应产出 | M3 bash 可中断执行 + M5 权限门 `src/permission.ts` |
| 硬数字 | 踩坑「杀父不杀孙」:`proc.kill` 只杀直接子进程,孙进程攥着 stdout 管道写端→不 EOF→傻等满超时;修法=`detached` 自成进程组+`process.kill(-pid)` 杀整组。实测 `sleep 5` 100ms 中断后 **2s 内返回**(tests 里是不变量) |
| 深度弹药 | 权限判定链(解剖 cc-haha 25 文件/bashPermissions 2621 行):deny→ask→工具自查→bypass→allow→**兜底是 ask 不是 deny**;正则尽头是 LLM 分类器(yoloClassifier 2-stage);诚实边界测试:`X=rm; $X -rf /` 变量拼接绕过 DANGER 正则后**落 ask 非 allow**——测自己的局限比假装没有更工程 |
| 一句话术 | "沙箱的本质是三层:执行前的权限门(三态)、执行中的进程组隔离与可中断、失败后的错误回填不崩 loop。" |
| 详见 | `docs/D3-流式输出与可中断对照.md`、`docs/D5-工具权限审批对照.md` |

### 3. 终端交互(JD 职责原文)

| 项 | 内容 |
|---|---|
| 对应产出 | M3 流式输出 `src/m3.ts` + m7 readline 壳(Esc 中断/y·n 审批) |
| 硬数字 | 工具中断实测 2.0s、模型流中断 2.5s(已吐 357 字即停,省钱);`.stream()` 边吐字 + `finalMessage()` 攒齐 |
| 深度弹药 | AbortController=取消的「协议层」,自己什么都不停(协作式取消,JS 版 CancellationToken/Kotlin `job.cancel`);一把 signal 两个监听者:模型流靠 fetch 原生 opt-in、bash 靠手动 addEventListener 接 kill。cc-haha 多 6 处生产加固(中断补 tool_result/流式降级+墓碑/idle watchdog…) |
| 一句话术 | "streaming 解决首 token 延迟,可中断解决'说错了能停'——两者共用一把 AbortController signal,贯穿模型流和工具执行。" |
| 详见 | `docs/D3-流式输出与可中断对照.md` |

### 4. 长记忆底层服务(JD 职责原文)

| 项 | 内容 |
|---|---|
| 对应产出 | M4 上下文压缩 `src/compact.ts`(estimateTokens+findCutPoint+LLM 总结老历史) |
| 硬数字 | **配对安全不变量**:保留段从 assistant 起,绝不劈开 tool_use/tool_result(孤儿 tool_result 会 400)——tests 里用 property test 遍历全部切割参数验证 |
| 深度弹药 | 真 CC 的 compact 全景(源码级):触发=窗口-13K 非百分比、三道线(warning/auto/blocking)+熔断连败3次;9 段摘要模板的取舍逻辑=**能重生成的压、不能重建的(用户意图/接续点/代码)顶着压缩本能保真**;CC 不止一种 compact(full/micro/snip/sessionMemory);压缩 vs 缓存的张力(改前缀炸 messages 段缓存,cache_edits beta 是唯一两全解) |
| 一句话术 | "压缩治'爆窗口',缓存治'贵',两者有张力:压缩改了前缀就炸缓存——我实测过压缩后第 4 轮 input 暴涨而 tools+system 段仍命中。" |
| 详见 | `docs/D4-上下文压缩与缓存对照.md`(含 compact 源码级深挖四部分) |

### 5. 上下文缓存(JD 技术栈原文)

| 项 | 内容 |
|---|---|
| 对应产出 | D4 caching:SYSTEM 打 cache_control + `withRollingCache`(滚动断点+副本防污染) |
| 硬数字 | 实测命中率 **83.8%**(glm 端点);经济学三种价 fresh 1×/write 1.25×@5min·2×@1h/read 0.1×,5min 2 次回本 |
| 深度弹药 | cache_control=元数据不进 token 流(图钉非仓库);前缀匹配是唯一不变量,三层缓存=嵌套前缀(Docker 分层);MCP per-user 破 global 缓存(system 的 KV 物理上长在 tools 上);**跨 provider:cache_control 非事实标准,Anthropic opt-in vs DeepSeek 默认开**——这条对 DeepSeek 面试是天然话题 |
| 一句话术 | "把不变的放前面、变的放后面;cache_control 是打给 API 的书签不占 token——顺带,DeepSeek 自家 API 是默认缓存不用打标,我对比过两种设计的取舍。" |
| 详见 | `docs/D4-上下文压缩与缓存对照.md` |

### 6. RAG 服务(JD 加分项)

| 项 | 内容 |
|---|---|
| 对应产出 | D9 `demo/rag-mini.ts`:经典 RAG 全流程(chunk→TF-IDF→余弦 top-k→augment→generate)+ agentic search 对照 |
| 硬数字 | TF-IDF 死穴铁证:同义两句余弦 **0.559 vs 0.091**(差 6 倍,只认词形不认语义);agentic 换词重试 4 轮 2650 token 刨出答案 |
| 深度弹药 | 三路检索对照(长上下文直塞 vs 经典 RAG vs agentic search)+ 为何代码场景 agentic 赢 RAG 的 6 条论述 + **nuance:CC 不用 RAG≠RAG 没用,会按场景选路比一边倒更值钱**;附录:解剖 Anthropic Contextual Retrieval(整篇文档打 cache 断点+haiku 生成定位上下文,Pass@10 87→95%,caching 省 69%)、读 benchmark 三问(谁做的/对照公平吗/数据挑没挑) |
| 一句话术 | "顶级编码 agent(CC)全库 grep 0 处向量检索——检索靠 ripgrep+LSP+Explore 子 agent;但非代码海量文档场景 RAG 仍是主流,我两条路都写过。" |
| 详见 | `docs/D9-RAG与检索对照.md`、`docs/D9-附录-生产级RAG深读.md` |

### 7. 多轮对话系统(JD 加分项)

| 项 | 内容 |
|---|---|
| 对应产出 | 整个 agent loop(M1 起):`while` + `stop_reason` 判断 + `tool_result` 回填 |
| 硬数字 | 实测自主循环 **11 轮**完成"列出最大 3 个文件并推测项目用途"(自己 pwd→ls→find→cat 甚至读自己源码) |
| 一句话术 | "agent loop 就是多轮对话的极端形态:每轮的'用户消息'是工具结果,模型自己决定下一步,直到 end_turn。" |
| 详见 | `docs/D1-深度问答笔记.md`、README 架构图 |

### 8. MCP / Tool Use / Function Calling 协议(Agent 基础设施岗 JD 明确点名)

| 项 | 内容 |
|---|---|
| 对应产出 | M6 `src/mcp.ts`:**手写 stdio JSON-RPC**(不依赖 SDK)——分帧/握手/pending Map 按 id 匹配 + `demo/mcp-server-calc.ts` 最小 server(吃透协议两端) |
| 硬数字 | 端到端真 LLM 自主调 `mcp__calc__add(2,3)=5→multiply(5,4)=20`;协议层 6/0 测试 |
| 深度弹药 | 错误二分(协议错误→JSON-RPC error→reject vs 工具执行错误→isError→软回填让模型重试);MCP 工具不信 annotations.readOnlyHint(spec 明警告 untrusted)一律落 ask 门;cc-haha 5 种 transport + 命名归一化 + MCP 当审批通道(channelPermissions 转发手机) |
| 一句话术 | "function calling 是模型↔单 app 内工具;MCP 是标准化协议让工具与任意 agent 解耦——我手写过协议两端,分帧、握手、错误二分都踩过一遍。" |
| 详见 | `docs/D6-MCP客户端对照.md` |

### 9. 重度使用 Claude Code / AI 编程工具(JD 加分项,多岗位共同点名)

| 项 | 内容 |
|---|---|
| 对应产出 | ①日常:CC 重度用户(全套 skill/hook/MCP/subagent 自定义工作流,自建 cc-connect Discord 桥接) ②深度:对照解剖 cc-haha(44 万行真实 CC 复刻),D2-D9 每模块"先自写最小版→再解剖参考实现" |
| 硬数字 | 能点名到文件+行号:query.ts 主循环、claude.ts:3131 cache 断点、compact.ts:387 压缩流水线、bashPermissions.ts 2621 行权限链…… |
| 一句话术 | "我不只是用 CC,是拆过它:每个模块先自己写最小版,再对照 44 万行复刻源码找差距——比如我的 edit 唯一性算法 23 行,和官方核心完全一致,差的是外面六层工程加固,我能一条条说出来。" |

### 10. 工程素养(隐性要求)

| 项 | 内容 |
|---|---|
| 对应产出 | D8 评估 + D10 打磨:**67 测试/174 断言/~0.3s/全离线零 API key**、CI(typecheck+test 零 secrets)、README(CI 徽章+Mermaid 架构图+三条设计主线) |
| 深度弹药 | 测试分层哲学:**该 fake 的是贵且非确定的 LLM,不该 fake 免费且确定的本地世界**;评估分层框架(确定性门禁/离线 eval/judge/运行时可观测/人工)——为什么 CC 不用 agent 任务 eval 当 CI 硬门(非确定性→flaky→团队麻木) |
| 一句话术 | "全离线是设计约束不是碰巧:离线→CI 零 secrets→任何人 fork 都绿→徽章可信。" |
| 详见 | `docs/D8-评估与可观测对照.md`、`docs/D10-作品打磨.md` |

---

## 二、差距与应对(被追问时的预案,主动、如实)

| 可能的追问 | 应答要点 |
|---|---|
| "你没做过后端?" | 不自我贬低。资深 client/framework 工程师(美团 Android 基架/淘宝基架/B站/努比亚 framework 层),内存管理、并发模型、跨进程通信、生命周期管理全部可迁移;真实 gap 是 LLM/Agent 领域知识,**已系统补完并有可运行项目证明**。Harness 恰恰是"framework 思维"岗位:内核-外壳分离、注册表模式、错误回填,全是基架功底。 |
| "没做过 IDE 插件/代码沙箱产品化?" | 如实承认。弥补:用 M6 MCP 解剖证明理解"工具生态与宿主解耦"的架构本质(cc-haha 5 种 transport);沙箱方向能讲进程组隔离/权限门/bypass-immune 的完整层次,差的是容器级隔离的生产经验。 |
| "与真 CC 的差距?" | **主动报差距清单**(比吹实现更证明看懂了):单 provider 无降级/权限正则演示级 vs 沙箱+策略引擎/无 IDE/LSP/无 hooks/压缩单级 vs 8 段模板。 |
| "为什么想来 DeepSeek?" | 结合 Harness 团队方向答:想做的就是 agent 运行时这层(不是模型训练也不是上层产品);顺手可提对 DeepSeek API 默认缓存 vs Anthropic opt-in 的设计对比(证明真研究过他家)。 |

---

## 三、5 分钟项目介绍(按 JD 四关键词组织顺序,非 README 顺序)

1. **开场 30s**:mini-cc=手写的 agent 运行时内核,覆盖 JD 四个词——工具调用、沙箱执行、终端交互、长记忆/缓存。方法论是双线:每模块先自写最小版,再解剖 44 万行真 CC 复刻找差距。
2. **工具调用 60s**:注册表设计→加工具零改 loop→MCP 和子 agent 都是"塞进数组"→edit 唯一性算法与官方一致。
3. **沙箱执行 60s**:权限三态门→进程组 kill 坑(杀父不杀孙)→诚实边界(变量拼接绕过正则落 ask)。
4. **终端交互 45s**:流式+一把 signal 两个监听者→中断实测 2s。
5. **长记忆+缓存 60s**:配对安全切割不变量→83.8% 命中率→压缩与缓存的张力。
6. **收尾 45s**:67 离线测试+CI+主动报与真 CC 的差距清单。

---

## 四、投递执行清单(按 2026-07-07 真实进度)

- [x] D11:十道面试题答题骨架(三段式:电梯版/展开版/追问防守)——已完成,见 `docs/D11-面试题答题骨架.md`
- [x] D11.5:缺口补强(LLM 通识五卡/生态对比/生产专题+客服系统设计+STAR×3+反问三问)——已完成,见 `docs/D11.5-通识补强卡.md`、`docs/D11.5-生态对比卡.md`、`docs/D11.5-生产专题与面试形态.md`
- [ ] **D12(下一步):模拟面试**——让 CC 扮演 DeepSeek Harness 面试官,拿 D1-D11.5 追问;定向加压三类:①沙箱/终端执行工程细节(进程组/信号) ②caching 与 context 的成本意识 ③"没做过 IDE 插件/代码沙箱产品化"的差距应答;另按本文档第三节练"JD 四关键词顺序"的 5 分钟项目介绍,脱稿讲数字
- [ ] D13:缓冲补漏 + 简历改写完成
- [ ] 简历主线叙事:不写"学习项目",写"实现了具备工具调用、沙箱执行、终端交互、上下文缓存、长记忆管理的 agent 运行时内核"+ 实测数字
- [ ] 附 GitHub 仓库链接(README 已有 CI 徽章+架构图,即作品集)
- [ ] 投递:deepseek.com 官网 / t.cn/AXisN0RS / 猎聘 / BOSS直聘(可并行)
- [ ] 投后 1-2 周无回复,猎聘/BOSS 主动催一次
