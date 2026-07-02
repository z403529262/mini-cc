// tools.ts —— 六个内置工具的行为契约。真实文件系统 + 真实子进程(临时目录隔离)，
// 不 mock fs：工具的价值就在「与真实世界交互的边界处理」，mock 掉就什么都没测。
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toolMap } from "../src/tools"

let tmp: string
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "minicc-test-")) })
afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

const run = (name: string, input: any, signal?: AbortSignal) => toolMap.get(name)!.execute(input, signal)

describe("write_file / read_file", () => {
  test("写入自动创建父目录，读回内容一致", async () => {
    const path = join(tmp, "a/b/c.txt")
    expect(await run("write_file", { path, content: "hello 世界" })).toContain("已写入")
    expect(await run("read_file", { path })).toBe("hello 世界")
  })

  test("读不存在的文件 → 错误回填成文本(不抛异常，让模型能看到并换方案)", async () => {
    expect(await run("read_file", { path: join(tmp, "nope.txt") })).toStartWith("[read_file 失败]")
  })

  test("空文件读出「(空文件)」而非空串(空串会让模型困惑)", async () => {
    const path = join(tmp, "empty.txt")
    writeFileSync(path, "")
    expect(await run("read_file", { path })).toBe("(空文件)")
  })
})

describe("edit_file 唯一性契约", () => {
  test("old_string 唯一 → 精确替换那一处", async () => {
    const path = join(tmp, "edit.txt")
    writeFileSync(path, "aaa TARGET bbb")
    expect(await run("edit_file", { path, old_string: "TARGET", new_string: "DONE" })).toContain("已编辑")
    expect(readFileSync(path, "utf8")).toBe("aaa DONE bbb")
  })

  test("出现 0 次 → 拒绝(告诉模型没找到)", async () => {
    const path = join(tmp, "edit0.txt")
    writeFileSync(path, "nothing here")
    expect(await run("edit_file", { path, old_string: "TARGET", new_string: "X" })).toContain("没找到")
  })

  test("出现多次 → 拒绝并报次数(防改错地方，这是 edit 比 sed 可靠的原因)", async () => {
    const path = join(tmp, "edit2.txt")
    writeFileSync(path, "dup dup")
    const out = await run("edit_file", { path, old_string: "dup", new_string: "X" })
    expect(out).toContain("2 次")
    expect(readFileSync(path, "utf8")).toBe("dup dup") // 一个字都没动
  })
})

describe("glob / grep", () => {
  test("glob 按模式匹配(含子目录)", async () => {
    // glob 的 cwd 写死 "."，测试期间临时切过去、finally 切回
    const dir = join(tmp, "globdir")
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "x.zzz"), "")
    writeFileSync(join(dir, "sub/y.zzz"), "")
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const out = await run("glob", { pattern: "**/*.zzz" })
      expect(out).toContain("x.zzz")
      expect(out).toContain(join("sub", "y.zzz"))
      expect(await run("glob", { pattern: "*.nomatch" })).toBe("(无匹配)")
    } finally {
      process.chdir(prev)
    }
  })

  test("grep 命中返回 文件:行号:内容；未命中返回「(无匹配)」而非报错(grep 退出码 1 不是错误)", async () => {
    const path = join(tmp, "grepme.txt")
    writeFileSync(path, "line one\nNEEDLE_XYZ here\n")
    const hit = await run("grep", { query: "NEEDLE_XYZ", path: tmp })
    expect(hit).toContain("grepme.txt")
    expect(hit).toContain(":2:")
    expect(await run("grep", { query: "NO_SUCH_NEEDLE_QQQ", path: tmp })).toBe("(无匹配)")
  })
})

describe("bash", () => {
  test("正常命令返回 stdout", async () => {
    expect(await run("bash", { command: "echo ok" })).toBe("ok\n")
  })

  test("失败命令 → [bash 失败] + 原因(回填给模型而非抛异常)", async () => {
    expect(await run("bash", { command: "exit 3" })).toContain("[bash 失败]")
  })

  test("★ 中断：sleep 5 在 100ms 内被杀掉整个进程组，立即收场", async () => {
    const ac = new AbortController()
    const start = Date.now()
    const p = run("bash", { command: "sleep 5" }, ac.signal)
    setTimeout(() => ac.abort(), 100)
    expect(await p).toBe("[bash 已中断]")
    expect(Date.now() - start).toBeLessThan(2000) // 不等 sleep 自然结束(5s)，也不等管道 EOF
  })

  test("signal 已 aborted → 不起子进程直接返回", async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await run("bash", { command: "echo never" }, ac.signal)).toBe("[bash 已中断]")
  })
})
