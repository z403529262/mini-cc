// 验证「放行 / 拦截 / 审批」三条路径的执行后果（不依赖真 LLM、不依赖真按键）。
// 把审批答案预设成 y / n（替代真人按键，同 D3/D4 套路），跑「权限门 → 执行 or 拒绝」全流程，
// 断言副作用是否真的发生。permission-check.ts 测「判定」，这里测「后果」。
import { toolMap } from "../src/tools"
import { checkPermission } from "../src/permission"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 复刻 m5 loop 里处理单个 tool_use 的核心：权限门 → deny 拒 / ask 问 / allow 放 → 执行
async function handleToolUse(name: string, input: any, approve: boolean) {
  const tool = toolMap.get(name)!
  const decision = checkPermission(tool, input)
  if (decision === "deny") return { decision, executed: false }
  if (decision === "ask" && !approve) return { decision, executed: false }
  await tool.execute(input) // allow 或 已批准 → 才执行
  return { decision, executed: true }
}

const dir = mkdtempSync(join(tmpdir(), "m5-"))
const f = join(dir, "x.txt")
let pass = 0, fail = 0
const check = (label: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${label}`) }

// ① 放行：只读工具 → 自动执行（approve 给 false 也照样跑，证明只读不问）
{
  const r = await handleToolUse("glob", { pattern: "*.ts" }, false)
  check(`放行  allow：glob 自动执行（decision=${r.decision} executed=${r.executed}）`, r.decision === "allow" && r.executed)
}

// ② 拦截：危险命令 → deny，即便 approve=true 也绝不执行（安全策略优先于人）
{
  const r = await handleToolUse("bash", { command: `rm -rf ${dir}/x` }, true)
  check(`拦截  deny ：rm -rf 未执行，approve=true 也挡得住（decision=${r.decision} executed=${r.executed}）`, r.decision === "deny" && !r.executed)
}

// ③ 审批·拒绝：写工具 ask，用户答 n → 不执行，文件未创建
{
  const r = await handleToolUse("write_file", { path: f, content: "hello" }, false)
  check(`审批  ask→n：write_file 未执行（decision=${r.decision} executed=${r.executed}）`, r.decision === "ask" && !r.executed)
  check(`         └─ 文件确实没被创建`, !existsSync(f))
}

// ④ 审批·同意：写工具 ask，用户答 y → 执行，文件真的写出且内容正确
{
  const r = await handleToolUse("write_file", { path: f, content: "hello" }, true)
  check(`审批  ask→y：write_file 执行（decision=${r.decision} executed=${r.executed}）`, r.decision === "ask" && r.executed)
  check(`         └─ 文件真的写出、内容正确`, existsSync(f) && readFileSync(f, "utf8") === "hello")
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
