// 验证 MCP 客户端的「协议层」：连 server → 握手 → 发现工具 → 调用 → 包装。
// 不依赖真 LLM、不依赖真按键(同 D3/D4/D5 套路)，纯断言副作用与返回值。
// permission-flow-check 测「权限三态后果」，这里测「MCP 协议跑没跑通」。
import { MCPClient } from "../src/mcp"
import { join } from "node:path"

const serverPath = join(import.meta.dir, "mcp-server-calc.ts") // 用绝对路径，不受 cwd 影响
const mcp = new MCPClient(["bun", "run", serverPath])

let pass = 0, fail = 0
const check = (label: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${label}`) }

// ① 握手 + 发现：connect 走完 initialize→initialized→tools/list，返回 2 个工具
const raw = await mcp.connect()
check(`发现工具：tools/list 返回 2 个（add / multiply）`, raw.length === 2)

const tools = mcp.toTools("calc")
const add = tools.find((t) => t.name === "mcp__calc__add")!
const mul = tools.find((t) => t.name === "mcp__calc__multiply")!

// ② 命名：包装后带 mcp__calc__ 前缀（防撞名，呼应真 CC）
check(`命名前缀：都是 mcp__calc__*`, tools.every((t) => t.name.startsWith("mcp__calc__")) && !!add && !!mul)

// ③ 权限默认：readOnly=false → 会落到权限门的 ask 分支（不信 server 的 readOnlyHint）
check(`权限默认：readOnly=false（MCP 工具一律过 ask 门）`, tools.every((t) => t.readOnly === false))

// ④⑤ 调用：tools/call 真的算对
const r1 = (await add.execute({ a: 2, b: 3 })).trim()
check(`调用 add(2,3) = 5（实得 ${r1}）`, r1 === "5")
const r2 = (await mul.execute({ a: 4, b: 5 })).trim()
check(`调用 multiply(4,5) = 20（实得 ${r2}）`, r2 === "20")

// ⑥ 错误路径：server 对非法参数返回 result.isError=true → execute 加 [MCP 错误] 前缀回填(不抛)
const r3 = await add.execute({ a: "oops", b: 3 })
check(`错误回填：isError → 前缀 [MCP 错误]（实得「${r3}」）`, r3.startsWith("[MCP 错误]"))

await mcp.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
