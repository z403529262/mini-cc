// D9 最小 RAG —— 手写检索增强生成的完整机件 + agentic 检索对照。
//
// RAG(Retrieval-Augmented Generation) = 回答前先从知识库检索相关片段、塞进 prompt，
// 让模型基于「现查的资料」答，而非「脑子里记的」。它治两个硬伤：
//   ① 模型上下文装不下整个知识库(一个代码库几百万 token)
//   ② 模型不知道你的私有数据、知识有截止日期
// 一句话类比：把闭卷考试变成开卷考试 —— 先翻书(检索)、再答题(生成)。
//
// 本 demo 两部分：
//   Part A 经典 RAG 全流程：chunk → embed(本地 TF-IDF) → 余弦 top-k → augment → generate
//          故意用 TF-IDF(词形匹配)留一个「同义词召不回」的天然缺口 —— 这正是真 embedding 的价值。
//   Part B agentic 对照：同一个同义词难题，改用 runAgent + grep/read 让 agent 自己迭代换词检索，
//          看 agentic search 如何靠「换关键词重试」突破 TF-IDF 的死穴(这就是 CC 不挂向量库的理由之一)。
//
// 跑法：bun run demo/rag-mini.ts
//   embedding 是本地算的、不碰网络；只有 generate / agentic 两步调 LLM(智谱端点)。

import Anthropic from "@anthropic-ai/sdk"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tools as builtinTools } from "../src/tools"
import { runAgent } from "../src/agent"

const client = new Anthropic({
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
const MODEL = "glm-4.6"

// ── 知识库：mini-cc 各模块小抄(每段讲一个模块) ─────────────────────────
// 注意第 2 段(edit_file)：用词是「替换 / 精确 / 字符串」，下面会拿它演示
// 「修改」这个同义词为什么 TF-IDF 召不回。
const KB = `\
mini-cc 的 agent loop 是内核：模型自己决定调用工具、读取执行结果、规划下一步，循环推进直到 stop_reason 不再是 tool_use。

edit_file 工具做精确字符串替换：old_string 必须在文件中唯一出现，否则报错，这样保证替换的就是想改的那一处。

权限审批在工具执行之前插一道门，分三态 allow ask deny：只读工具自动放行，写文件和危险命令要先问用户。

prompt caching 把系统提示和历史打上缓存断点，命中后这部分按十分之一价计费，治 agent 每轮全量重发的高成本。

上下文压缩在窗口快满时，用模型把老历史总结成结构化摘要，只保留近期几轮，治长对话爆窗口。

MCP 客户端用 stdio JSON-RPC 连外部工具进程，把外部工具包装成本地 Tool 并入注册表，agent loop 零改动。

子 agent 是隔离上下文的任务：派一个全新消息历史的子循环去做调研型子任务，只把最终结论回收给主 agent。`

// chunk：按空行切段。真实 RAG 还会按固定 token 数滑窗 + 段间重叠，这里从简。
function chunk(text: string): string[] {
  return text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean)
}

// tokenize：中英文混合 —— 英文按词(小写)，中文按单字。够演示 TF-IDF。
function tokenize(s: string): string[] {
  return [...s.toLowerCase().matchAll(/[a-z0-9_]+|[一-龥]/g)].map((m) => m[0])
}

// 余弦相似度：两向量夹角的 cos，∈[0,1](本例非负)。1=方向一致(最相关)，0=正交(无关)。
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// ── TF-IDF 向量化(本地「伪 embedding」) ──────────────────────────────
// TF = 词在本段的频率(本段多重要)；IDF = log(段总数 / 含该词的段数)(这词区分度多高，
//   「到处都有」的词权重被压低)。段向量 = 全局词表每一维上的 TF×IDF。
// 这是最朴素的文本向量化：只认词形(字面),不认语义 —— 缺点下面会现场暴露。
class TfidfIndex {
  vocab: string[] = []
  idxMap = new Map<string, number>()
  idf: number[] = []
  vectors: number[][] = []
  chunks: string[] = []

  build(chunks: string[]) {
    this.chunks = chunks
    const docTokens = chunks.map(tokenize)
    // 1) 建全局词表
    const vocabSet = new Set<string>()
    docTokens.forEach((ts) => ts.forEach((t) => vocabSet.add(t)))
    this.vocab = [...vocabSet]
    this.idxMap = new Map(this.vocab.map((w, i) => [w, i]))
    // 2) 算 IDF(每个词在几段里出现过 → 区分度)
    const df = new Array(this.vocab.length).fill(0)
    docTokens.forEach((ts) => new Set(ts).forEach((t) => (df[this.idxMap.get(t)!] += 1)))
    const N = chunks.length
    this.idf = df.map((d) => Math.log(N / (d || 1)) + 1) // +1 平滑，避免权重为 0
    // 3) 每段算 TF-IDF 向量
    this.vectors = docTokens.map((ts) => this.vectorize(ts))
  }

  // 把一串 token 投到「词表维度」的 TF-IDF 向量。词表外的词被忽略(TF-IDF 死穴之一)。
  vectorize(tokens: string[]): number[] {
    const v = new Array(this.vocab.length).fill(0)
    tokens.forEach((t) => { const i = this.idxMap.get(t); if (i !== undefined) v[i] += 1 })
    const n = tokens.length || 1
    return v.map((tf, i) => (tf / n) * this.idf[i])
  }

  embed(text: string): number[] { return this.vectorize(tokenize(text)) }

  // 检索：query 向量 vs 每段向量算余弦，降序取 top-k。
  retrieve(q: string, k: number) {
    const qv = this.embed(q)
    return this.vectors
      .map((v, i) => ({ chunk: this.chunks[i], score: cosine(qv, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }
}

// ── augment + generate：top-k 片段拼进 prompt，喂裸 LLM 作答 ──────────
// system 严格限定「只能用参考资料」—— 这样召回错了/漏了，答案会暴露(说"资料未提及")，
// 反过来说明：RAG 的答案质量上限 = 召回质量。检索拉胯，生成再强也没用。
async function ragAnswer(index: TfidfIndex, q: string, k = 2): Promise<string> {
  const hits = index.retrieve(q, k)
  const ctx = hits.map((h, i) => `[片段${i + 1}] ${h.chunk}`).join("\n")
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: "你只能根据【参考资料】回答；资料里没提到就直说\"资料未提及\"。不要用资料外的知识。",
    messages: [{ role: "user", content: `参考资料：\n${ctx}\n\n问题：${q}` }],
  })
  return (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim()
}

// ============ Part A：经典 RAG ============
console.log("\n========== Part A：经典 RAG(本地 TF-IDF 向量化) ==========")
const chunks = chunk(KB)
const index = new TfidfIndex()
index.build(chunks)
console.log(`知识库 ${chunks.length} 段 · 词表 ${index.vocab.length} 词\n`)

// Q1：词形能命中(问「权限审批」，知识库里就有这几个字) → RAG 正常工作的样子
const q1 = "权限审批是怎么做的？"
console.log(`Q1(词形能命中)：${q1}`)
index.retrieve(q1, 2).forEach((h, i) => console.log(`  召回${i + 1} ${h.score.toFixed(3)}：${h.chunk.slice(0, 28)}…`))
console.log(`  RAG 答：${await ragAnswer(index, q1)}\n`)

// TF-IDF 死穴铁证(不依赖召回运气/LLM)：两句语义几乎一样、词形不同 → 对同一段的余弦天差地别。
const editVec = index.vectors[1] // 第 2 段 = edit_file(替换/精确/字符串)
const sHigh = cosine(index.embed("精确替换字符串"), editVec)       // 词形高度重叠
const sSyn = cosine(index.embed("变更档案的部分文本"), editVec)    // 同义、但几乎零词形重叠
console.log(`TF-IDF 死穴铁证(都 vs edit_file 段)：`)
console.log(`  词形重叠「精确替换字符串」      → ${sHigh.toFixed(3)}`)
console.log(`  同义低重叠「变更档案的部分文本」 → ${sSyn.toFixed(3)}`)
console.log(`  ↑ 两句意思几乎一样，分数却天差地别 = TF-IDF 只认词形、不认语义。`)
console.log(`     真 embedding 会把近义词压到相近向量，让两者分数都高 —— 这就是它值钱的地方。\n`)

// ============ Part B：agentic search 对照 ============
// 同样的同义词难题，换 agentic：把知识库写成文件，给 agent grep/glob/read 工具，让它自己迭代。
// grep 一个词没命中就换近义词重试 —— 这正是 mini-cc(和真 Claude Code)的检索方式。
console.log("========== Part B：agentic search 对照(同样难题，换 grep/read 迭代) ==========")
const KB_DIR = "demo/scratch/rag-kb"
rmSync(KB_DIR, { recursive: true, force: true })
mkdirSync(KB_DIR, { recursive: true })
chunks.forEach((c, i) => writeFileSync(join(KB_DIR, `mod-${i}.md`), c))

const q2 = `知识库在 ${KB_DIR} 目录(每个 .md 一段)。问题：怎么修改一个文件里的内容？请检索后用知识库里的原话回答。`
const result = await runAgent({
  client,
  model: MODEL,
  system: `你用 grep / glob / read_file 在指定目录里检索知识库来回答问题。grep 一个关键词没命中，就换近义词(例如「修改」→「替换」「编辑」)再试，多试几次再下结论。`,
  tools: builtinTools.filter((t) => t.readOnly), // 只读三件套 read/glob/grep，自动放行
  messages: [{ role: "user", content: q2 }],
  approve: () => true,
  maxTurns: 8,
})
console.log(`agentic 答(${result.turns} 轮 / ${result.usage.fresh + result.usage.cached} tok)：\n  ${result.text}`)
console.log(`\n↑ TF-IDF 召不回的同义词，agent 靠「换关键词重试」自己刨出来了。`)
console.log(`   这就是 Claude Code 选 agentic search、不挂向量库的核心理由之一(更多见 docs/D9)。`)

process.exit(0)
