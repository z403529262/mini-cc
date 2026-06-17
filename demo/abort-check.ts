// D3 可中断机制验证：把「用户按 Esc」换成「setTimeout 自动 abort」，
// 中断路径完全一样（ac.abort() → signal → 掐流 / 杀子进程），只是不需要 TTY。
import Anthropic from "@anthropic-ai/sdk"
import { toolMap } from "../src/tools"

// —— 验证 1：工具中断（bash 子进程被 kill）——
{
  const bash = toolMap.get("bash")!
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 2000) // 2s 后模拟按 Esc
  const t0 = Date.now()
  const out = await bash.execute({ command: "sleep 10 && echo NOPE" }, ac.signal)
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[工具中断] 耗时 ${sec}s（期望≈2s 而非 10s） → ${out}`)
}

// —— 验证 2：模型流中断（正在传输的 HTTP 流被掐）——
{
  const client = new Anthropic({
    baseURL: "https://open.bigmodel.cn/api/anthropic",
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 2500) // 2.5s 后模拟按 Esc（让它先吐一会儿再掐）
  const stream = client.messages.stream(
    { model: "glm-4.6", max_tokens: 4096, messages: [{ role: "user", content: "写一篇 1500 字的散文，主题随意，慢慢展开。" }] },
    { signal: ac.signal },
  )
  let chars = 0
  stream.on("text", (d) => { chars += d.length })
  const t0 = Date.now()
  try {
    await stream.finalMessage()
    console.log("[模型中断] 居然没被中断？意外")
  } catch (e: any) {
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[模型中断] 耗时 ${sec}s，已吐 ${chars} 字后被掐 → ${e.name || e.message}`)
  }
}
