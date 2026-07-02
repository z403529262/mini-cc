// mcp.ts —— 协议层集成测试：起一个【真】MCP server 子进程(demo/mcp-server-calc.ts)，
// 走完 stdio JSON-RPC 握手/发现/调用/关闭全流程。离线(本机子进程)但不 mock —— 协议
// 实现的坑全在分帧/配对/错误二分里，mock 掉等于没测。
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { MCPClient } from "../src/mcp"
import type { Tool } from "../src/tools"

const SERVER = join(import.meta.dir, "..", "demo", "mcp-server-calc.ts")

let client: MCPClient
let wrapped: Tool[]

beforeAll(async () => {
  client = new MCPClient(["bun", SERVER])
  await client.connect()
  wrapped = client.toTools("calc")
})
afterAll(async () => { await client.close() })

describe("握手与发现", () => {
  test("tools/list 发现 add / multiply 两个工具", () => {
    expect(wrapped.map((t) => t.name).sort()).toEqual(["mcp__calc__add", "mcp__calc__multiply"])
  })

  test("包装成本地 Tool：mcp__ 前缀防撞名，inputSchema → input_schema", () => {
    const add = wrapped.find((t) => t.name === "mcp__calc__add")!
    expect((add.input_schema as any).required).toEqual(["a", "b"])
  })

  test("★ 保守策略：server 自称 readOnlyHint:true，client 仍标 readOnly:false 过权限门(不盲信)", () => {
    for (const t of wrapped) expect(t.readOnly).toBe(false)
  })
})

describe("调用", () => {
  test("add(7,5) = 12", async () => {
    expect(await wrapped.find((t) => t.name === "mcp__calc__add")!.execute({ a: 7, b: 5 })).toBe("12")
  })

  test("multiply(6,7) = 42", async () => {
    expect(await wrapped.find((t) => t.name === "mcp__calc__multiply")!.execute({ a: 6, b: 7 })).toBe("42")
  })

  test("参数非法 → 工具执行错误(result.isError) → 回填 [MCP 错误]，模型能看到原因", async () => {
    const out = await wrapped.find((t) => t.name === "mcp__calc__add")!.execute({ a: "not-a-number", b: 1 })
    expect(out).toStartWith("[MCP 错误]")
    expect(out).toContain("必须是数字")
  })

  test("未知工具 → JSON-RPC 协议错误(与 isError 是两类错误，spec 的关键二分)", async () => {
    // 故意伸进私有 request 直发协议消息 —— 就是要验证「协议 error」这条路，公开 API 到不了这里
    await expect((client as any).request("tools/call", { name: "no_such", arguments: {} }))
      .rejects.toThrow("未知工具")
  })
})
