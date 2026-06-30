// D9 帽子补全② 重试 / 降级 —— 生产 agent 的「韧性」基础设施。
//
// 为什么要它：LLM API 是网络服务，失败是常态(限流 429 / 超时 / 5xx / 网络抖动)。
// agent 跑几十轮，任一轮 API 失败就崩。重试 + 降级让它扛得住。
//
// 三件事：
//   ① 指数退避(exponential backoff + jitter)：失败等 1s/2s/4s… 再试，加随机抖动防「惊群」。
//   ② 区分可重试 vs 不可重试：429 / 5xx / 超时 / 网络 → 重试；
//      400 参数错 / 401 鉴权错 → 重试无意义(再试还是错)，立即放弃，别浪费配额、别放大故障。
//   ③ 模型降级 fallback：主模型连续失败(或 overloaded 529)，换备用模型继续。
//
// 验证用 fake 注入(同 D7/D8 思路)：真去触发 429 不现实，就注入「前 N 次抛错、之后成功」的假调用，
// 验证退避逻辑 / 可重试判定 / fallback 切换 —— 确定性强，不靠运气。
//
// 注：真实接 Anthropic SDK 时，SDK【自带】对 429/5xx/超时的重试(默认 maxRetries:2)。
//   手写一遍是为了①理解机制②自定义策略(SDK 的 fallback 换模型这步它不管)。
//
// 跑法：bun run demo/retry-fallback.ts

// —— 模拟 API 错误：带 status(对齐 Anthropic.APIError 的形状) ——
class FakeAPIError extends Error {
  constructor(public status: number, msg: string) { super(`${status} ${msg}`) }
}
// 可重试判定(核心)：限流 / 服务端错误才重试；客户端 4xx(除 429)不重试；无 status 的网络错默认可重试。
function isRetryable(e: any): boolean {
  if (e instanceof FakeAPIError) return e.status === 429 || e.status >= 500
  return true
}

// —— ① 指数退避重试 ——
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 4, baseMs = 50, label = "call" } = opts
  let lastErr: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      lastErr = e
      if (!isRetryable(e)) {
        console.log(`  [${label}] 第 ${attempt + 1} 次失败：${e.message} → 不可重试，立即放弃`)
        throw e
      }
      if (attempt === maxRetries) break
      const delay = baseMs * 2 ** attempt + Math.random() * baseMs // 指数 + jitter
      console.log(`  [${label}] 第 ${attempt + 1} 次失败：${e.message} → ${delay.toFixed(0)}ms 后重试`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

// —— ③ 模型降级 fallback：每个模型先各自重试，整体失败再换下一个 ——
async function withFallback<T>(models: string[], fn: (model: string) => Promise<T>): Promise<T> {
  let lastErr: any
  for (const model of models) {
    try {
      return await withRetry(() => fn(model), { maxRetries: 2, label: model })
    } catch (e: any) {
      lastErr = e
      console.log(`  [fallback] 模型 ${model} 重试到顶仍失败 → 降级下一个`)
    }
  }
  throw lastErr
}

// ============ 验证 ============
console.log("=== 重试 / 降级 ===\n")

// 场景1：前 2 次 429、第 3 次成功 → 退避重试到成功
console.log("场景1：限流 429 两次后成功(应重试到成功)")
let n1 = 0
const r1 = await withRetry(async () => {
  if (++n1 <= 2) throw new FakeAPIError(429, "rate limited")
  return "成功(第 3 次)"
}, { label: "scene1" })
console.log(`  结果：${r1}　共调用 ${n1} 次\n`)

// 场景2：400 参数错 → 不重试，立即放弃(对照 429)
console.log("场景2：400 参数错(不可重试，应立即放弃)")
let n2 = 0
try {
  await withRetry(async () => { n2++; throw new FakeAPIError(400, "invalid param") }, { label: "scene2" })
} catch {}
console.log(`  实际只调用了 ${n2} 次(没浪费重试)${n2 === 1 ? " ✓" : " ✗"}\n`)

// 场景3：主模型一直 overloaded、备用成功 → fallback 切换
console.log("场景3：主模型 529 overloaded → 降级到备用模型")
const r3 = await withFallback(["glm-primary", "glm-backup"], async (model) => {
  if (model.includes("primary")) throw new FakeAPIError(529, "overloaded")
  return `备用模型 ${model} 成功`
})
console.log(`  结果：${r3}\n`)

console.log("洞见：可重试判定是核心 —— 对 400/401 死磕是浪费(还可能放大故障)，对 429/5xx 才退避重试。")
console.log("      fallback 把「重试」从『同模型再试』升级到『换模型再试』，扛得住单模型过载。")
process.exit(0)
