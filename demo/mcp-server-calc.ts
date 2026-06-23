// 最小 MCP server —— 纯 stdio JSON-RPC，不依赖任何 SDK。
// 存在的意义：被 src/mcp.ts(client) 连接，用来吃透 MCP 协议的【server 端】。
//
// 协议三件套(按官方 spec 2025-06-18)：
//   1) stdio 分帧：一条消息 = 一行 JSON，以 \n 分隔，消息内【不能】有裸换行；
//      stdout 只许放合法 MCP 消息，日志一律走 stderr。
//   2) 握手：client 发 initialize → server 回能力 → client 发 notifications/initialized(无 id 的通知)。
//   3) 工具：tools/list 报菜单、tools/call 点菜。
//
// 提供两个工具 add / multiply，都标 annotations.readOnlyHint:true —— 这是故意的：
// 用来演示「server 自称只读，client 仍保守地把它当有副作用、过 ask 权限门」(见 src/mcp.ts)。
// 错误分两类(spec 的关键二分)：未知工具=JSON-RPC 协议 error；参数非法=result.isError(工具执行错误)。

type Req = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }

const PROTOCOL_VERSION = "2025-06-18"

const TOOLS = [
  {
    name: "add",
    description: "两个数相加，返回它们的和。",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number", description: "加数" }, b: { type: "number", description: "加数" } },
      required: ["a", "b"],
    },
    annotations: { readOnlyHint: true }, // 纯计算、无副作用 —— 但 client 不该盲信(见 spec 警告)
  },
  {
    name: "multiply",
    description: "两个数相乘，返回它们的积。",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number", description: "乘数" }, b: { type: "number", description: "乘数" } },
      required: ["a", "b"],
    },
    annotations: { readOnlyHint: true },
  },
]

// 写回一条响应 —— 一行 JSON + 换行，这就是 stdio 分帧的全部
function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function handle(req: Req) {
  const { id, method, params } = req

  // 通知(无 id)不需要回响应。notifications/initialized 是 client「握手完成」的信号，收下即可。
  if (id === undefined) return

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} }, // 声明「我提供 tools 能力」
        serverInfo: { name: "calc", version: "0.1.0" },
      },
    })
  }

  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {}
    if (name === "add" || name === "multiply") {
      const a = Number(args?.a), b = Number(args?.b)
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        // 参数非法 = 工具执行错误 → 走 result.isError(不是协议 error)，让模型能看到原因、换参数重试
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `参数必须是数字，收到 a=${args?.a} b=${args?.b}` }], isError: true } })
      }
      const text = name === "add" ? String(a + b) : String(a * b)
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } })
    }
    // 未知工具 = 协议级错误 → 走 JSON-RPC error
    return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `未知工具: ${name}` } })
  }

  // 其它没实现的方法
  return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `未实现的方法: ${method}` } })
}

// —— 按行读 stdin：累积 buffer，遇 \n 切一行，逐行 JSON.parse ——
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) }
    catch (e) { process.stderr.write(`[calc-server] 解析失败: ${e}\n`) } // 日志走 stderr
  }
})
// client 关掉我们的 stdin(shutdown 第一步) → 我们退出
process.stdin.on("end", () => process.exit(0))
