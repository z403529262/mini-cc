// D8 eval 任务集 —— 每个任务 = prompt + 程序化判据(check)。
// 判据判「任务有没有达成」(查文件状态 / 输出关键词)，而不是「过程一不一样」——
// 这是 agent 评估区别于传统单测的关键：agent 非确定性、多种正确答案，过程不可复现。
// 5 个任务覆盖 write / edit / glob+grep / mcp / task，把 M2–M7 的能力都 eval 到。

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

export interface EvalResult {
  pass: boolean
  detail: string
}
export interface EvalTask {
  name: string
  dir: string
  prompt: string
  setup?: () => void // 跑前准备 scratch 目录/文件，保证可重复
  check: (output: string) => EvalResult // output = runAgent 返回的末条文本
}

const ROOT = "demo/scratch"
const t1 = join(ROOT, "eval-t1")
const t2 = join(ROOT, "eval-t2")
const t3 = join(ROOT, "eval-t3")
const t4 = join(ROOT, "eval-t4")
const t5 = join(ROOT, "eval-t5")

// 每个任务跑前清空自己的目录 —— eval 必须可重复，残留会让结果不可信
function freshDir(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}
function read(path: string): string {
  try { return readFileSync(path, "utf8") } catch { return "" }
}

export const tasks: EvalTask[] = [
  {
    name: "T1-write",
    dir: t1,
    prompt: `在 ${t1}/greet.ts 写一个 TypeScript 函数 greet(name)，返回字符串 "Hello, " 拼上 name。`,
    setup: () => freshDir(t1),
    check: () => {
      const code = read(join(t1, "greet.ts"))
      if (!code) return { pass: false, detail: "greet.ts 未创建" }
      const hasFn = /function\s+greet|greet\s*[:=]/.test(code)
      const hasHello = code.includes("Hello")
      return { pass: hasFn && hasHello, detail: hasFn ? (hasHello ? "greet 函数 + Hello 都在" : "有函数但缺 Hello") : "没找到 greet 函数" }
    },
  },
  {
    name: "T2-edit",
    dir: t2,
    prompt: `把 ${t2}/calc.ts 里的加法改成减法，其余保持不变。`,
    setup: () => {
      freshDir(t2)
      writeFileSync(join(t2, "calc.ts"), "export function calc(a: number, b: number) {\n  return a + b\n}\n")
    },
    check: () => {
      const code = read(join(t2, "calc.ts"))
      const minus = code.includes("a - b")
      const noPlus = !code.includes("a + b")
      return { pass: minus && noPlus, detail: `含减法=${minus} 已去加法=${noPlus}` }
    },
  },
  {
    name: "T3-search",
    dir: t3,
    prompt: `在 ${t3} 目录下，找出所有内容里包含 TODO 的 .ts 文件，列出它们的文件名。`,
    setup: () => {
      freshDir(t3)
      writeFileSync(join(t3, "a.ts"), "// TODO: fix this\nexport const a = 1\n")
      writeFileSync(join(t3, "b.ts"), "export const b = 2\n")
      writeFileSync(join(t3, "c.ts"), "export const c = 3\n// TODO: refactor\n")
    },
    check: (out) => {
      const hasA = out.includes("a.ts")
      const hasC = out.includes("c.ts")
      return { pass: hasA && hasC, detail: `命中 a.ts=${hasA} c.ts=${hasC}` }
    },
  },
  {
    name: "T4-mcp",
    dir: t4,
    prompt: `用 calc 工具计算 (7+5)*2 等于多少，告诉我最终结果。`,
    setup: () => freshDir(t4),
    check: (out) => {
      const ok = out.includes("24")
      return { pass: ok, detail: ok ? "结果含 24" : "结果不含 24" }
    },
  },
  {
    name: "T5-task",
    dir: t5,
    prompt: `用 task 工具派一个子 agent，数一下 ${t5} 目录下有几个 .ts 文件，把数字告诉我。`,
    setup: () => {
      freshDir(t5)
      writeFileSync(join(t5, "x.ts"), "export const x = 1\n")
      writeFileSync(join(t5, "y.ts"), "export const y = 2\n")
      writeFileSync(join(t5, "z.ts"), "export const z = 3\n")
      writeFileSync(join(t5, "readme.md"), "not a ts file\n")
    },
    check: (out) => {
      const ok = out.includes("3")
      return { pass: ok, detail: ok ? "数出 3" : "没数出 3" }
    },
  },
]
