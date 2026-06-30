# D9 — RAG 与检索：从手写最小 RAG 到「为什么 Claude Code 不挂向量库」

> 双线螺旋第 9 站。前 8 站(D1–D8)全是 **agent 内核**(loop / 工具 / 流式 / 压缩缓存 / 权限 / MCP / 子 agent / 评估)，从没碰过「检索」。D9 补上最后一个面试高频缺口：**RAG / 检索增强**。
>
> 讲解遵循 `docs/讲解约定.md`：what / why 优先，怎么办其次，不一句话抛结论。

---

## 第一部分 · RAG 是什么、为什么(what / why)

### 是什么

**RAG = Retrieval-Augmented Generation(检索增强生成)**：模型回答之前，先从一个外部知识库里**检索**出与问题相关的片段，把它们塞进 prompt，再让模型基于「现查到的资料」作答——而不是只靠「参数里记住的」。

一句话类比(Android 视角)：
- 模型的参数权重 = **编译进 APK 的常量**：发版即固化、改不了、也装不下太多。
- RAG = 运行时去**读一个外部配置 / 数据库**：按需取当前最相关的那几条。

更直白：**把闭卷考试改成开卷考试**。闭卷靠脑子记(模型参数)，开卷允许翻书(检索)——而且书还能随时更新。

### 为什么需要它(含反例)

不用 RAG、直接把所有资料塞进 prompt 行不行？三个反例说明为什么不行：

1. **装不下**。一个中型代码库轻松几百万 token，模型上下文窗口才 200K–1M，物理塞不进去。
2. **不知道 / 过时**。模型不知道你公司的私有文档、内部 wiki；它的知识还有训练截止日期，问它上周的事一问三不知。
3. **塞得下也不该全塞**。就算挤得进去，也会撞上 **"lost in the middle"**(长上下文里**中间**段落的信息最容易被模型忽略)，而且每轮对话全量重发 = 又慢又贵(这正是 D4 caching / 压缩要治的病)。

**RAG 的本质 = 用「检索」换「上下文」**：不把整座图书馆搬进考场，只把这道题相关的那几页递进去。省窗口、省钱、还可能更准(噪音少)。

---

## 第二部分 · 最小 RAG 的机件(逐件拆 + mini-cc 实现)

经典 RAG 流水线六步，mini-cc 在 `demo/rag-mini.ts` 里全手写了一遍：

```
chunk  →  embed  →  index  →  retrieve(余弦 top-k)  →  augment  →  generate
切片      向量化     存         按相似度召回最相关 k 段      拼进 prompt    喂 LLM 作答
```

逐件看(每件先说「为什么要这一步」)：

### ① chunk 切片
**为什么**：检索的粒度。一篇长文档不能整篇当一个检索单位——要切成小段，才能「只召回相关的那一段」。
- 切太大 → 召回里混进无关内容(噪音)，还浪费 token。
- 切太小 → 一句话被切断，丢了上下文，召回了也看不懂。
- mini-cc：按空行切段(`chunk()`)。真实 RAG 还会**按固定 token 数滑动窗口 + 段间重叠**(overlap)，避免把一个完整意思切在边界上。

### ② embed 向量化(本步是 RAG 的灵魂)
**为什么**：要让机器判断「问题」和「片段」相不相关，得先把文本变成数字向量，且满足**语义相近 → 向量相近**。这样「求相关」就变成「求向量距离最近」。
- 生产用**真 embedding 模型**(OpenAI text-embedding / 智谱 embedding-3 / BGE 等)：把语义压进几百~几千维向量，近义词在向量空间里也接近。
- mini-cc 用 **TF-IDF**(本地「伪 embedding」，零依赖零网络)：
  - TF = 词在本段出现的频率(本段里多重要)。
  - IDF = log(段总数 / 含该词的段数)：「到处都有」的词权重压低，区分度高的词权重抬高。
  - 段向量 = 全局词表每一维上的 TF × IDF。
  - **关键缺陷**：TF-IDF 只认**词形**(字面)，不认**语义**。下面现场暴露。

### ③ index 存储
**为什么**：query 来了要快速找最近邻。
- mini-cc：内存数组，召回时线性扫一遍算余弦(`retrieve()`)。几段够用。
- 生产：**向量数据库**(FAISS / pgvector / Pinecone / Milvus)，用 **ANN(近似最近邻)** 算法，百万级向量也能毫秒召回。

### ④ retrieve 召回(余弦 top-k)
**为什么**：从全库挑出与问题最相关的 k 段。
- query 用**同一套** embed 方法向量化，和每段算**余弦相似度**(夹角的 cos，1 = 方向一致最相关，0 = 正交无关)，降序取前 k。
- mini-cc：`cosine()` + `retrieve(q, k)`。

### ⑤ augment 增强
**为什么**：把召回的 top-k 片段拼进 prompt，作为「参考资料」喂给模型。

### ⑥ generate 生成
**为什么**：模型基于资料作答。mini-cc 的 `ragAnswer()` 用 system 严格限定**「只能用参考资料、资料没有就说未提及」**——这条约束暴露了一个 RAG 铁律：

> **召回质量 = RAG 的答案上限**。检索拉胯(漏召 / 错召)，生成模型再强也救不回——它只能基于你递进去的资料答。Garbage in, garbage out。**所以 RAG 工程的重心在检索侧(chunk 策略 / embedding / rerank)，不在生成侧。**

### mini-cc 实测：TF-IDF 的死穴(为什么生产要上真 embedding)

`demo/rag-mini.ts` Part A 跑出一个**不依赖召回运气**的铁证——两句**语义几乎相同、词形不同**的话，对同一段(edit_file 段)的余弦：

| query | 对 edit_file 段的余弦 |
|---|---|
| 「精确替换字符串」(词形高度重叠) | **0.559** |
| 「变更档案的部分文本」(同义、几乎零词形重叠) | **0.091** |

两句意思几乎一样，分数差 6 倍。**这就是 TF-IDF 只认词形、不认语义的死穴**。真 embedding 会把这两句压到相近向量、两者分数都高——这正是它值钱、且生产 RAG 必须用它的地方。

> mini-cc 故意用 TF-IDF 留这个缺口：面试时说清「我手写了 RAG 全流程，也清楚 TF-IDF 的边界在哪、真版要换 embedding」——比硬接一个 API 更能体现你懂原理、知道简化在何处。

---

## 第三部分 · 三路检索对照(D9 的灵魂、面试主菜)

同样是「让模型用上知识库」，有三条路。**这是面试最高频的对比题**(「RAG vs 长上下文」、「context 管理怎么做」)：

| | ① 长上下文直塞 | ② 经典 RAG | ③ agentic search |
|---|---|---|---|
| **机制** | 把整个知识库塞进 prompt | 向量召回 top-k 片段塞进去 | 给 agent grep/glob/read，自己迭代检索 |
| **谁决定取哪些** | 不挑，全要 | embedding 相似度(一次性) | LLM 自己(可多轮换词、顺藤摸瓜) |
| **成本** | 最贵(每轮全量重发) | 省(只塞 top-k) | 中(多轮 LLM 调用，靠小模型/隔离压) |
| **准确性软肋** | lost in the middle | 召回受 embedding/chunk 限制，一次定生死 | 慢；依赖 agent 会不会搜 |
| **维护** | 无 | **要建 / 更新向量索引** | **零索引**，现场读最新 |
| **适用** | 小知识库、单文档 | 海量文档、低迭代预算(客服 / 文档问答) | 代码库、需要精确 + 可迭代 |

mini-cc 把 ②③ 都真跑了一遍(`demo/rag-mini.ts`)：
- **Part A(经典 RAG)**：同义词 query「修改文件」→ TF-IDF 召回分 0.091，基本召不回。
- **Part B(agentic)**：同一个难题，换 `runAgent`(D7 复用) + grep/read，agent **自己换关键词重试**(「修改」→「替换」「编辑」)，**4 轮 2650 token 就刨出了正确答案**。

> 同一个同义词难题：**RAG 一次召回定生死、露怯；agentic 靠 LLM 迭代换词、反而稳**。这一条直接通向第四部分的反共识。

---

## 第四部分 · 解剖 cc-haha：为什么它 0 向量库、不做 RAG

### 坐实事实

grep 整个 cc-haha 源码(44 万行)：**0 处**余弦相似度 / 向量库 / embedding 检索(唯一命中「embedding」的 `utils/bash/ast.ts` 是 AST 解析里的无关词)。一个顶级编码 agent，**检索完全不靠向量 RAG**。它靠三件套：

#### 1. ripgrep —— 精确正则检索(GrepTool)
- 后端是 **ripgrep**(`GrepTool.ts:21 import { ripGrep }`)，比 mini-cc 的系统 grep 多了生产加固：**gitignore 感知**(`:418`)、**`--` 注入防护**(`:379`，防 query 被当成 rg 选项——对应 mini-cc 用 `execFileSync` 逐参传的同款考虑)、超时。
- 工具描述里有强引导(`GrepTool/prompt.ts:10`)：**"ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command"**——强制走专用工具(权限 / 访问已优化)。
- 还做了分层(`:14`)：**"Use Agent tool for open-ended searches requiring multiple rounds"**——单次精确搜用 Grep，开放式多轮搜派子 agent。

#### 2. LSP —— 符号级精确检索(LSPTool)
- LSPTool 是个大件(`LSPTool.ts` 25KB)，集成**语言服务器协议**，提供(`LSPTool/prompt.ts:3-14`)：goToDefinition(找定义)、findReferences(找所有引用)、call hierarchy(incoming / outgoing calls 调用链)、workspaceSymbol(全工程符号搜索)……
- **这是「语义检索」，但语义来自编译器的 AST + 类型系统，不是向量相似度**。查「这个函数谁调用了」，LSP 给你**精确**答案；向量相似度只能给你「看起来像的代码」。`symbolContext.ts:getSymbolAtPosition` 是它的位置→符号取词(精确，非模糊)。

#### 3. Explore 子 agent —— agentic search 的活样本(exploreAgent)
CC 把「大范围语义检索」做成了一个**只读探索子 agent**(`exploreAgent.ts`，直接接 D7 子 agent)。它的设计处处为 agentic search 优化：
- 角色:"file search specialist... excel at navigating codebases"(`:24`)，**READ-ONLY 强约束**(`:26-36`)。
- **强制 fan-out**:`EXPLORE_AGENT_MIN_QUERIES = 3`(`:59`，至少 3 次查询) + "spawn multiple **parallel** tool calls for grepping and reading"(`:52-54`)。
- **成本压制**:外部用户跑 **haiku**(`:78`，检索是广度扫描、不需要顶配模型) + **omitClaudeMd: true**(`:81`，不加载 CLAUDE.md 的 commit/lint 规则 = 精简上下文、更快更省)。
- **递归防护 + 只读**:disallowedTools 剔掉 Agent / Edit / Write / NotebookEdit(`:67-73`，呼应 D7 递归防护 + D5 只读)。
- 三档 thoroughness:quick / medium / very thorough(`:62`)。

### 为什么代码场景 agentic 赢过 RAG(6 条，面试核心论述)

1. **代码要精确，不要模糊**。查 `getUserById` 你要的就是那个函数，不是「语义相似」的一堆候选。grep / LSP 精确匹配 > 向量近似。
2. **可迭代**。一次没搜到就换词重试、grep→read→再 grep 顺藤摸瓜(mini-cc Part B 实测)。RAG 一次召回定生死。
3. **零索引、永远读最新**。代码每分钟在变；向量库要重建索引、增量更新、还有 embedding 漂移。agentic 现场读，永不过期。
4. **无 chunk 边界问题**。RAG 切块会切断函数 / 类的完整性；agentic 读整文件、或用 LSP 取完整符号。
5. **LSP 兜底真语义**。需要「语义」时(找定义 / 引用 / 调用链)，编译器级 LSP 比向量相似度准得多。
6. **成本可控**。agentic 多轮看似贵，但 CC 用「小模型(haiku) + 精简上下文(omitClaudeMd) + 子 agent 隔离(结论回收、不污染主上下文，D7)」把它压下来了。

### 别偏激(关键 nuance，防面试翻车)

**「CC 不用 RAG」≠「RAG 没用」**。RAG 在这些场景仍是主流、且更优：**非代码的海量自然语言文档**(客服知识库、企业 wiki、法律 / 医疗文档问答)、**低迭代预算**(一次问答、不允许 agent 多轮试错)、**召回延迟敏感**。代码场景 agentic 赢，是**代码的特殊性**(精确标识符 + 强结构 + 有 grep/LSP 这类精确工具)决定的，不是 RAG 本身不行。**会区分「什么场景用哪条路」，比一边倒地吹某条路更能体现判断力。**

---

## 第五部分 · 脉络与复用

- D9 不是 mini-cc 的内核里程碑(M0–M7 是内核)，是**「LLM 应用通识」**层。但它和 agent 内核咬合得很紧：
  - **检索 = agent 的「外部记忆」**。agent 的工具(grep / glob / read)本身就是一套 agentic 检索系统——D2 写工具时其实已经把 agentic search 的地基打好了。
  - **Part B 直接复用 D7 的 `runAgent`**(`src/agent.ts`)：把同一个检索难题交给一个真 agent 跑。这是 runAgent 继 task(D7)、eval(D8)之后的**第三次复用**——再次印证那次抽象抽对了。
  - **agentic 检索的成本，靠 D4(caching / 压缩) + D7(子 agent 隔离)兜底**：检索的中间过程(一堆 grep 结果)留在子 agent 上下文里，只把结论回收给主 agent，主上下文不被污染。
- mini-cc 现有的 agentic 三件套：`src/tools.ts` 的 grep(`:100`) / glob(`:82`) / read_file(`:20`)。

---

## 第六部分 · 面试金句

1. **「RAG 的本质是用检索换上下文——不把整座图书馆搬进考场，只递相关的那几页。」**
2. **「召回质量是 RAG 的答案上限。检索漏了错了，生成模型再强也救不回。所以 RAG 工程的重心在检索侧(chunk / embedding / rerank)，不在生成侧。」**
3. **「TF-IDF 只认词形、不认语义——同义词查询直接露怯(我实测同义两句对同一段余弦差 6 倍)。这就是为什么生产 RAG 必须上真 embedding：把近义词压到相近向量。」**
4. **「Claude Code 是个顶级编码 agent，但全代码库 0 向量库、0 RAG。它靠 ripgrep(精确) + LSP(符号级) + Explore 子 agent(agentic 多轮检索)。」**
5. **「代码场景 agentic search 赢 RAG，因为代码要精确不要模糊、要可迭代、要读最新、有 grep/LSP 这类精确工具；而 RAG 一次召回定生死、要维护索引、有 chunk 边界。」**
6. **「但这不代表 RAG 没用——海量自然语言文档、低迭代预算的问答场景，RAG 仍是主流。会按场景选路，比一边倒吹一条路更值钱。」**
7. **「agentic 检索看着贵(多轮 LLM)，但能用小模型(haiku) + 精简上下文 + 子 agent 隔离把成本压下来——CC 的 Explore agent 就是这么设计的。」**

---

> 验证：`bun run demo/rag-mini.ts`(Part A 经典 RAG + TF-IDF 死穴铁证；Part B agentic 对照)。embedding 本地算、不碰网络；只 generate / agentic 两步调 LLM。
