# D9 附录 · 生产级 RAG 深读

> D9 主体手写了最小 RAG(`demo/rag-mini.ts`,TF-IDF 玩具)。这篇附录把「玩具」对照到「真货」——clone 并解剖 Anthropic 官方 **Contextual Retrieval** cookbook 源码,映射经典六步,再用一个真实 benchmark 教怎么**不被数字唬住**。
>
> 三块:① 源码解析 ② 经典六步映射 ③ 批判性读 RAG benchmark。讲解遵循 `docs/讲解约定.md`(what/why 优先)。
>
> 解剖样本:`~/my/openSource/claude-cookbooks/capabilities/contextual-embeddings/`(git clone 自 `anthropics/claude-cookbooks`,和 cc-haha 并列当解剖样本)。

---

## 第一部分 · Contextual Retrieval 源码解析

### 0. 它解决什么 · 文件结构

**一句话**:经典 RAG 把文档切碎后,单个 chunk 丢了全局上下文(一段写「它涨了 3%」,不知道「它」指谁)。Contextual Retrieval 的解法是 **embed 之前,用 Claude 给每个 chunk 生成一句「定位上下文」,拼到 chunk 前面再 embed**。

```
contextual-embeddings/
├── guide.ipynb              # 主教程(15 code + 18 markdown cells)
├── data/
│   ├── codebase_chunks.json # 9 个代码库切好的 737 chunks(知识库)
│   └── evaluation_set.jsonl # 248 条 query + golden chunk(评估集)
└── contextual-rag-lambda-function/  # AWS Bedrock 生产部署版(lambda_function.py)
```

> 注意知识库就是**9 个代码库**——Anthropic 一边让 Claude Code 不用 RAG(D9 主文),一边官方出「对代码做 RAG」的 cookbook。不矛盾:Claude Code 是交互式 agent(可迭代 grep),cookbook 面向「自建 RAG 应用的开发者」(没有 agent 多轮预算的场景)。**产品形态不同,选路不同。**

### 1. 核心机制:`situate_context`(精华就这十几行)

```python
def situate_context(doc, chunk):
    response = client.messages.create(
        model="claude-haiku-4-5",          # ← 用 haiku,辅助任务不需要顶配
        temperature=0.0,                    # ← 要稳定,关随机
        messages=[{"role": "user", "content": [
            {"type": "text",
             "text": f"<document>{doc}</document>",       # ① 整篇文档
             "cache_control": {"type": "ephemeral"}},      # ← 关键!整篇打缓存断点
            {"type": "text",
             "text": f"<chunk>{chunk}</chunk> 给一句定位上下文,只回上下文别的别说"},  # ② 这个 chunk
        ]}],
        extra_headers={"anthropic-beta": "prompt-caching-2024-07-31"},
    )
    return response.content[0].text, response.usage
```

**三个为什么(why)**:

1. **content 分两块、整篇文档在前 + 打 `cache_control`**:同一文档的**所有 chunk 共享「整篇文档」这个前缀**。第一个 chunk 把全文写进缓存(付小溢价),后面每个 chunk 直接读缓存(**90% 折扣**)。这就是 **D4 学的 cache 前缀机制的实战**——「不变的」(整篇文档)放前面打断点,「变的」(chunk 提问)放后面。所以**必须按文档顺序处理 chunk**(不能 shuffle),否则缓存命不中。
2. **用 haiku 不用 opus**:生成「一句定位」是简单辅助任务——和 **D9 里 Explore 子 agent 用 haiku 压成本**完全同一思路(辅助任务用小模型)。
3. **拼接**:`text_to_embed = f"{生成的上下文}\n\n{原 chunk}"` → 再丢给 voyage embedding。metadata 同时存 `original_content` + `contextualized_content`(后者 rerank 时还要用)。

### 2. 工程精华三点

| 精华 | 实现 | 连到你学过的 |
|---|---|---|
| **caching 前缀打法** | 整篇文档当公共前缀打 `ephemeral` 断点 | D4 caching 前缀机制实战 |
| **小模型做辅助** | 生成 context 用 haiku | D9 Explore 子 agent 用 haiku |
| **VectorDB 极简** | in-memory list + pickle 落盘 + `np.dot` 余弦(voyage 向量已归一,点积=余弦)+ batch 128 | 和 `rag-mini` 的内存 `vectors[]` **同级** |

`ContextualVectorDB` 在 `VectorDB` 基础上加:`ThreadPoolExecutor` 并行 contextualize、`threading.Lock` 线程安全统计 token、cache 命中率追踪。

### 3. 实测数据(官方,硬)

- **召回**:Pass@10 基础 RAG **87%** → contextual embed **92%** → +BM25 +rerank **~95%**;召回失败率平均**降 35%**。
- **成本(caching 省钱)**:737 chunks,**61.83% input token 命中缓存**(2.27M token @90% off),`$9.20 → $2.85`(省 69%)。
- **成本模型**:800-token chunk、8k-token 文档、100 token 上下文 → **$1.02 / 百万文档 token**。
- **关键**:contextual 是**一次性 ingestion 成本**(建库时付),不是每次 query 付——对比 HyDE(每查都加延迟)。

### 4. 生产版(`lambda_function.py`)

AWS 部署形态:从 S3 读 chunk → 对每 chunk 调 Bedrock 用**同一个 prompt** 生成 context → `context + "\n\n" + chunk` 写回 S3 → 挂到 Bedrock Knowledge Base 当「自定义分块」。同一套机制,换 S3 + Bedrock 的壳。证明这套不是 demo 玩具,是真能上生产的形态。

---

## 第二部分 · 映射经典 RAG 六步

**结论:骨架就是经典六步,创新集中在 embed/index/retrieve 三步的增强 + 多挂一个 rerank。** 逐步对:

| 经典六步 | Contextual Retrieval 实际怎么走 | 动了没 |
|---|---|---|
| ① chunk 切片 | 按字符 / heading 切(数据集已预切 `codebase_chunks.json`) | 不变 |
| ② embed 向量化 | ⭐**核心改动**:embed 前先用 haiku 把 `整篇文档+chunk` → 生成定位上下文 → `context + "\n\n" + chunk` 一起喂 voyage embed | **增强** |
| ③ index 存储 | ⭐**双索引**:向量库(in-memory pickle)**+ 额外建 BM25 索引**(Elasticsearch),BM25 也用上下文化内容 | **增强** |
| ④ retrieve 召回 | ⭐**混合检索**:向量 top-k + BM25 top-k → 加权融合(`bm25_weight=0.2`)出候选 | **增强** |
| (+) rerank | ⭐**经典六步外新增**:Cohere `rerank-english-v3.0` 对候选二次精排,取 top-k | **新增** |
| ⑤ augment 增强 | top-k 拼进 prompt 当参考资料 | 不变 |
| ⑥ generate 生成 | 喂 LLM 作答 | 不变 |

**一句话**:它没改六步骨架,**独门绝活只在第②步**(embed 前加定位上下文,治 chunk 丢全局);其余(③双索引、④混合、+rerank)都是**业界通用的 RAG 增强套路**,不是它独创。

为什么要 BM25 混合?——补语义搜索的死穴:**精确词/函数名召不回**(正是 D9 主文 TF-IDF 那一课)。文中明说 **BM25 是 TF-IDF 的改进版**(加了文档长度归一 + 词频饱和)。所以你 `rag-mini` 的 TF-IDF 是 BM25 的「爷爷」。

---

## 第三部分 · 怎么批判性读 RAG benchmark

D9 主文引用过一句「Elastic 实测 RAG 比长上下文更准 + 更低延迟 + 更低成本」。把这个 benchmark 拆开,正好示范**怎么不被数字唬住**。

### 它真测了什么(一手)

- **数据集**:Elastic **自家的** 303 篇 Search Labs 文章(~100 万 token)
- **模型**:Gemini 2.0 Flash
- **对照组**:`match-all` 查询——**把全部 303 篇一股脑塞进 context**

| | 文本 RAG | 全量塞 LLM |
|---|---|---|
| 发送 token | 237 | 1,023,231 |
| 延迟 | 1.28s | 45.65s |
| 成本 | $0.000029 | $0.102 |
| 准确率 | ✓ | ✗(失败/多答) |

→ 便宜 **1250 倍**、快 **45 倍**,长上下文侧因塞太多出现 "attention loss"(就是 lost in the middle)。

### 三重立场,数字没撒谎但「针对性」

1. **谁做的**:Elasticsearch 是搜索 / 向量库公司,**卖的就是检索层**。RAG 需要检索 = 它的生意;长上下文直塞 = 绕过检索 = 砸它饭碗。**它做这对比天然有动机让 RAG 赢**。
2. **对照组是稻草人**:对照组是「不过滤地塞全部 303 篇」——**最蠢的用法,没人真这么干**。拿 RAG 跟「最浪费的做法」比,赢 1250 倍近乎**同义反复**(「只发 237 个相关 token 当然比发 100 万便宜」)。公平的对手该是「长上下文 + 预过滤 / 缓存」。
3. **数据集撑窗口**:用自家 100 万 token 文章把 context 撑到吃力,放大长上下文劣势。

**所以它证明的是「别不过滤地把所有东西塞进去」,不是「RAG 全面碾压长上下文」。**

### 对照中立来源(没有卖搜索的屁股)

- **Google(EMNLP 2024 / arXiv 2407.16833)**:长上下文**资源足时常更准**,RAG 赢性价比,**Self-Route 混合**最优。
- **LaRA(ICML 2025)**:**没有银弹**,看任务 / 模型。

中立结论温和得多:**不是碾压,是各有所长 + 按任务选 / 混合**。和 Elastic 的「1250 倍碾压」差着量级——差距就来自「谁做的 + 对照公不公平」。

### 读任何 benchmark 的三问

1. **谁做的?** 有没有卖相关产品的立场(屁股决定结论)。
2. **对照组公平吗?** 是不是拿自己跟「对手最蠢的用法」比(稻草人)。
3. **数据集有没有被挑?** 是不是专挑放大自己优势的数据。

> 这套和「看研报先看谁写的、假设站不站得住」是一个道理。面试被甩「我们实测 RAG 快 1250 倍」,你能反问「对照组是不是不过滤地塞?数据集多大?谁做的?」——立刻显出不被数字唬住的判断力。

---

## 第四部分 · 和 mini-cc 的连接 + 升级 checklist

`rag-mini`(玩具)→ Contextual Retrieval(生产)的升级路线,正好是一张 checklist:

| 环节 | `rag-mini` 现状 | 升级到生产 |
|---|---|---|
| chunk | 按空行切 | tree-sitter 按函数 + 重叠 + **contextual 前缀** |
| embed | TF-IDF(词形) | 真 embedding(voyage)+ embed 前 contextualize |
| index | 内存数组 | 向量库 **+ BM25 双索引** |
| retrieve | 纯余弦 top-k | **向量 + BM25 混合融合** |
| rerank | 无 | **Cohere reranker 精排** |
| augment/generate | 已有 | 不变 |

**这篇附录 = 你手里所有 D 的拼图合体**:RAG(D9)+ caching 前缀(D4)+ 小模型省成本(D9 Explore)+ 评估 Pass@k(D8 eval 思想)。读懂它,等于把 D4/D8/D9 在一个真实生产库里串了一遍。

---

## 第五部分 · 追问深挖:chunk / embed / index 的具体实现 + RAG vs Elasticsearch

> 追问沉淀。前三问是「六步的前三步在这个库里**具体**怎么做的」,第四问掰正一个常见的层级混淆。

### §1 chunk 到底怎么切的?——不是自然段落,是字符硬切、零重叠(数据实测)

先说关键事实:**这个 cookbook 自己根本不切**——它用预切好的 `codebase_chunks.json` 当输入。切片是 RAG 独立一步,cookbook 想聚焦演示 contextual 那步,就拿现成数据控制变量。

jq 实测数据:

| 指标 | 值 |
|---|---|
| 9 个代码库 | → **90 个源文件 → 737 chunks** |
| chunk 大小 | 平均 **674 字符**(min 237 / max 3898) |
| 每文件 chunk 数 | 1 ~ 83 |
| **doc 原文 vs chunks 拼接** | **8677 == 8677,完全相等** |

最后一行是铁证:原文长度 == 所有 chunk 长度之和 → **逐字符切、不重不漏、零 overlap**。样本看切点恰落在 struct `}` / `impl` 边界附近,但本质是 markdown 自述的 "**basic character splitting**"(按字符数硬切),不是按自然段落。

**为什么故意用笨切法?** 字符硬切必然把函数/类拦腰截断 → chunk 必丢上下文——**正是这个「病」给了 contextual retrieval 表演舞台**(切得越聪明,contextual 的收益越不明显)。生产最佳实践:按 token 切 + 滑窗 overlap(50-100 token)、或结构感知切(tree-sitter 按函数 / markdown 按 heading / RecursiveCharacterTextSplitter 递归找切点)。

### §2 embed 具体怎么做的?——文本 → 定长「语义指纹」

把一段文本送进 embedding 模型(这里 Voyage `voyage-2`),输出**定长浮点数组**(1024 维)。模型的训练目标就是**语义相近 → 向量相近**,于是「判断相关」变成「算向量距离」。

> 别和 tokenize 混:tokenize = 文本 → token id **序列**(喂 LLM 输入);embedding = **整段文本 → 一个语义向量**(给检索)。两码事。

代码四个要点(`_embed_and_store`):
1. **batch 128**:128 个 chunk 凑一批调一次 API(减少往返,embedding 也按 token 计费)。
2. **pickle 落盘**:算完存 `.pkl`,embedding 只付一次钱。
3. **contextual 版的关键**:embed 的不是裸 chunk,是 `f"{haiku生成的定位上下文}\n\n{原chunk}"` → 向量编码的是「带上下文的 chunk」→ 这就是召回失败率降 35% 的来源。
4. **query 侧**:必须用**同一个模型**(voyage-2)embed 成向量(同向量空间才能比距离),且有 `query_cache` 防重复。

### §3 index 存储怎么做的?——其实是两件事,和「一般存储」差在哪

这个库的做法(极简):

```python
# 存:两个并行 Python list + pickle,没有任何索引结构
self.embeddings = [...]; self.metadata = [...]
# 查:暴力全扫——query 和全部 737 个向量算点积,排序取 top-k
similarities = np.dot(self.embeddings, query_embedding)  # voyage 已归一化→点积=余弦
top_indices = np.argsort(similarities)[::-1][:k]
```

这是 **O(N) 暴力(flat / brute-force)**。「index 存储」在 RAG 里其实是**两件事**:①存向量 ②怎么快速找最近邻。它把两件都做成最简版。

**和一般存储的区别,分两层**:

1. **vs 传统数据库(MySQL 等)——查询范式根本不同**:传统库查「等于 / 范围 / 关键词」(B-tree / 哈希 / 倒排);向量存储查「**谁离我最近**」(最近邻)。B-tree 对「找最像」**无能为力**——「相似」不是「相等」,没法排序树二分。这就是为什么需要专门的向量检索。
2. **vs 生产向量库(FAISS / pgvector / Pinecone)——差在 ANN 索引**:737 个向量暴力扫毫秒级够用;百万级就废了。生产用 **ANN 近似最近邻**:HNSW(分层小世界图,最常用)/ IVF(倒排聚类,只扫最近几簇)/ PQ(量化压缩省内存)——共同点是 **O(N) → ~O(log N),牺牲一点点召回精度换几个数量级的速度**。

另注意:contextual 版实际存了**两份索引**——向量库(管语义)+ Elasticsearch BM25 倒排(管精确词),第④步混合检索各出一路。

### §4 RAG vs Elasticsearch——不是对手,是层级不同

**RAG 是架构/方法,ES 是具体引擎/组件**,不能平行比。Android 类比:RAG ≈ MVVM(架构模式,规定「先检索再生成」怎么组织);ES ≈ Room(具体组件,干「存 + 查」);**RAG 的检索层可以用 ES 实现**,但 MVVM 不一定用 Room、Room 也不只为 MVVM。

- **同(交集)**:都围绕「检索相关信息」;ES 8.x 一家能包掉 RAG 的整个 retrieve 步(BM25 关键词 + dense_vector kNN 向量 + RRF 混合)——本附录 contextual retrieval 的 BM25 索引用的就是 ES。
- **异(本质)**:①层级不同(图纸 vs 砖);②范围不同——ES 用途远不止 RAG(ELK 日志 / 全文搜索 / APM / SIEM),RAG 检索层也不一定用 ES(纯向量库 / agentic grep);③包含关系——完整 RAG = 检索层(可能是 ES)+ embedding + LLM + 编排,ES 只占检索层。
- **澄清一个易混点**:第三部分那个 Elastic benchmark **不是「ES vs RAG」**,是「**用 ES 做检索的 RAG** vs 不过滤塞长上下文」。**ES 是 RAG 的『卖铲人』,不是 RAG 的对手**——它做该 benchmark 的动机正是证明「用我的铲子挖矿」比「徒手」强。

一句话:**RAG 是「先查再答」的打法,Elasticsearch 是「查」这一步可选的一台引擎。打法不绑引擎,引擎不止这一种打法。**

---

## 第六部分 · 面试金句

1. **「Contextual Retrieval 的核心就十几行:embed 前用 haiku 给每个 chunk 加一句全局定位,召回失败率降 35%。工程精髓是用 prompt caching 把整篇文档当公共前缀缓存,成本砍 69%——我读过源码,VectorDB 就是内存数组 + 余弦。」**
2. **「它没改 RAG 六步骨架,独门绝活只在 embed 那一步(加上下文);混合检索、rerank 都是通用增强。会区分『独创』和『通用套路』,比笼统说『用了 contextual retrieval』更显深度。」**
3. **「读 benchmark 先问三件事:谁做的(立场)、对照组公不公平(稻草人)、数据集挑没挑。Elastic 那个『RAG 快 1250 倍』,对照组是不过滤地塞 100 万 token——证明的是别犯傻,不是 RAG 碾压。」**
4. **「BM25 是 TF-IDF 的改进版。生产 RAG 用『语义 + BM25 混合』,正是因为纯向量召不回精确词(函数名/术语)——语义和关键词各补一刀。」**
5. **「我 jq 实测过它的 chunk 数据:doc 原文长度等于所有 chunk 长度之和——逐字符硬切、零重叠。故意用最笨的切法留『丢上下文』的病,给 contextual 表演;切得越聪明,contextual 收益越小。」**
6. **「index 其实是两件事:存向量、找最近邻。玩具用内存 list + 暴力点积,生产用 ANN(HNSW/IVF)拿一点召回换几个数量级速度;B-tree 对『找最像』无能为力——这就是为什么需要向量库。」**
7. **「RAG 和 Elasticsearch 不是对手:RAG 是架构,ES 是检索层的一种引擎——ES 是 RAG 的卖铲人。Elastic 那个 benchmark 测的是『用 ES 的 RAG』vs『不过滤塞长上下文』,别读成 ES vs RAG。」**

---

> 验证 / 复现:`~/my/openSource/claude-cookbooks/capabilities/contextual-embeddings/guide.ipynb`(需 ANTHROPIC/VOYAGE/COHERE key,跑全量 ~$5-10)。本附录的源码引用与数据均出自该 notebook 与 `lambda_function.py`。
