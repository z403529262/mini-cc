// MCP 客户端 —— 手写 stdio JSON-RPC，把外部 MCP server 的工具接进 mini-cc。
//
// 是什么：MCP(Model Context Protocol) 是「给 agent 接外部工具」的标准协议。
//   mini-cc 内置工具(tools.ts)是硬编码的；MCP 让我们运行时连上一个独立进程(server)，
//   问它有哪些工具(tools/list)、再调用它们(tools/call)。用户 system 里的 mcp__* 工具就是这么来的。
// 为什么手写：MCP 核心就是 stdio + JSON-RPC，手写百来行能看清握手/发现/调用全过程，
//   比用官方 SDK(黑盒)更契合「吃透内核」的目标。
// 关键设计：toTools() 把 MCP 工具包装成本地 Tool(tools.ts:12) 形状 ——
//   于是 agent loop 和权限门(m5.ts) 一行都不用改，直接把它当内置工具用。这就是好抽象的回报。

import type { Tool } from "./tools"

const PROTOCOL_VERSION = "2025-06-18" // 与 spec 对齐；server 不支持会回它支持的版本

// MCP 工具的形状(注意是 camelCase 的 inputSchema，与我们 Tool 的 input_schema 不同)
type McpTool = {
  name: string
  description?: string
  inputSchema: any
  annotations?: { readOnlyHint?: boolean; [k: string]: any }
}
type Pending = { resolve: (v: any) => void; reject: (e: any) => void }

export class MCPClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">
  private pending = new Map<number, Pending>() // id → 等待中的请求；响应按 id 回 resolve
  private idSeq = 0
  private mcpTools: McpTool[] = []

  // 构造即把 server 起成子进程：stdin 我们写、stdout 我们读、stderr 收日志
  constructor(cmd: string[]) {
    this.proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  }

  // 后台循环：从 server 的 stdout 按 \n 分帧、逐行解析。必须在发第一个请求前就跑起来。
  private async readLoop() {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) this.onLine(line)
      }
    }
  }

  // server 的日志(stderr)转发出来，方便调试 —— 不混进 stdout 这条数据通道
  private async pipeStderr() {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stderr as ReadableStream<Uint8Array>) {
      const s = decoder.decode(chunk).trimEnd()
      if (s) console.error(`[MCP stderr] ${s}`)
    }
  }

  // 收到一行 → 解析 → 按 id 把响应交回给等待的 request
  private onLine(line: string) {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`)) // JSON-RPC 协议错误
      else p.resolve(msg.result)
    }
    // 无 id / 不在 pending = server 主动发的通知，这个最小 client 先忽略
  }

  // 发一个请求(带 id)，返回 Promise，等同 id 的响应回来才兑现；带超时兜底防 server 挂死
  private request(method: string, params?: any): Promise<any> {
    const id = ++this.idSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP 请求超时: ${method}`)) }, 10_000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      this.proc.stdin.flush()
    })
  }

  // 发一个通知(无 id，不等响应) —— 用于 notifications/initialized
  private notify(method: string, params?: any) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    this.proc.stdin.flush()
  }

  // 走完握手三步，返回发现到的工具清单(原始 MCP 格式)
  async connect(): Promise<McpTool[]> {
    this.readLoop().catch((e) => console.error(`[MCP readLoop] ${e}`))
    this.pipeStderr().catch(() => {})
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {}, // 我们这个 client 不提供 roots/sampling/elicitation 能力
      clientInfo: { name: "mini-cc", version: "0.1.0" },
    })
    this.notify("notifications/initialized") // 告诉 server：握手完成，可以正常干活了
    const result = await this.request("tools/list", {})
    this.mcpTools = result?.tools ?? []
    return this.mcpTools
  }

  // ★ 关键：把每个 MCP 工具包装成本地 Tool —— 包装后就能塞进 toolMap，loop/权限门零改动
  toTools(serverName: string): Tool[] {
    return this.mcpTools.map((t) => ({
      name: `mcp__${serverName}__${t.name}`, // 加前缀防与内置工具/别的 server 撞名(同真 CC 命名)
      readOnly: false,                        // 保守：不信 annotations.readOnlyHint，一律过 ask 权限门
      description: t.description ?? "",
      input_schema: t.inputSchema as Tool["input_schema"], // camelCase → 我们接口的 input_schema
      execute: async (input: any) => {
        try {
          const result = await this.request("tools/call", { name: t.name, arguments: input })
          const text = (result?.content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n")
          // 工具执行错误(result.isError) → 加前缀回填给模型(不抛)，让它换方案，风格同内置工具
          if (result?.isError) return `[MCP 错误] ${text || "工具执行失败"}`
          return text || "(无文本输出)"
        } catch (e: any) {
          // 协议错误(reject) / 超时 → 也回填成文本，不让一个工具崩掉整个 loop
          return `[MCP 调用失败] ${e.message}`
        }
      },
    }))
  }

  // 优雅关闭(stdio shutdown)：先关 server 的 stdin → 等它自己退 → 兜底 kill
  async close() {
    try { this.proc.stdin.end() } catch {}
    await Promise.race([this.proc.exited, Bun.sleep(2000)])
    try { this.proc.kill() } catch {}
  }
}
