import { execFileSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type Anthropic from "@anthropic-ai/sdk"

// 工具的统一抽象：一份给模型看的「说明书」(name/description/input_schema)
// + 一个给代码用的「执行体」(execute)。两者合在一个对象里，但职责分明。
// M3 起 execute 升级为 async + 可选 signal —— 这才是工具的正确形态：
//   异步 → 长命令不阻塞 event loop；signal → Esc 一到就能中断。
export interface Tool {
  name: string
  description: string
  input_schema: Anthropic.Tool["input_schema"]
  execute(input: any, signal?: AbortSignal): Promise<string>
}

const read_file: Tool = {
  name: "read_file",
  description: "读取指定文件的全部内容。",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "文件路径" } },
    required: ["path"],
  },
  execute: async ({ path }) => {
    try { return readFileSync(path, "utf8") || "(空文件)" }
    catch (e: any) { return `[read_file 失败] ${e.message}` }
  },
}

const write_file: Tool = {
  name: "write_file",
  description: "把内容整体写入文件（覆盖原内容；文件不存在则创建）。",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的完整内容" },
    },
    required: ["path", "content"],
  },
  execute: async ({ path, content }) => {
    try {
      mkdirSync(dirname(path), { recursive: true }) // 父目录不存在就自动建（真 CC 的 write 也这么做）
      writeFileSync(path, content)
      return `已写入 ${path}（${content.length} 字符）`
    } catch (e: any) { return `[write_file 失败] ${e.message}` }
  },
}

// ★ D2 的明星：精确字符串替换。比让模型用 bash sed 安全可靠得多。
const edit_file: Tool = {
  name: "edit_file",
  description: "把文件中的 old_string 精确替换为 new_string。old_string 必须在文件中【唯一出现】，否则报错——这样保证改的就是你想改的那一处。",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: { type: "string", description: "要被替换的原文（需在文件中唯一出现）" },
      new_string: { type: "string", description: "替换成的新内容" },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: async ({ path, old_string, new_string }) => {
    try {
      const content = readFileSync(path, "utf8")
      const hits = content.split(old_string).length - 1
      if (hits === 0) return `[edit_file 失败] 没找到 old_string，改不了`
      if (hits > 1) return `[edit_file 失败] old_string 出现 ${hits} 次、不唯一；请带上更多上下文让它唯一`
      writeFileSync(path, content.replace(old_string, new_string))
      return `已编辑 ${path}（替换 1 处）`
    } catch (e: any) { return `[edit_file 失败] ${e.message}` }
  },
}

const glob: Tool = {
  name: "glob",
  description: "按 glob 模式查找文件，例如 src/**/*.ts。返回匹配的文件路径。",
  input_schema: {
    type: "object",
    properties: { pattern: { type: "string", description: "glob 模式，如 **/*.ts" } },
    required: ["pattern"],
  },
  // 用了 Bun 专属的 Bun.Glob（bun 项目里最省事；要可移植可换 node 的 fs.glob）
  execute: async ({ pattern }) => {
    try {
      const files = Array.from(new Bun.Glob(pattern).scanSync({ cwd: ".", onlyFiles: true }))
      return files.length ? files.slice(0, 100).join("\n") : "(无匹配)"
    } catch (e: any) { return `[glob 失败] ${e.message}` }
  },
}

const grep: Tool = {
  name: "grep",
  description: "在文件里按关键词搜索内容，返回 文件:行号:内容。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要搜索的字符串" },
      path: { type: "string", description: "搜索的目录或文件，默认当前目录" },
    },
    required: ["query"],
  },
  // 用 execFileSync（不走 shell）逐参传入，避免 query 被当 shell 命令注入——比 execSync 安全
  execute: async ({ query, path = "." }) => {
    try {
      return execFileSync("grep", ["-rIn", "--exclude-dir=node_modules", query, path], { encoding: "utf8" }) || "(无匹配)"
    } catch (e: any) {
      if (e.status === 1) return "(无匹配)" // grep 没命中时退出码为 1，不是错误
      return `[grep 失败] ${e.message}`
    }
  },
}

const bash: Tool = {
  name: "bash",
  description: "执行一条 bash 命令（用于上面专门工具覆盖不到的操作）。",
  input_schema: {
    type: "object",
    properties: { command: { type: "string", description: "bash 命令" } },
    required: ["command"],
  },
  // M3：从 execSync 换成异步子进程 —— 两个收益：
  //   1) 异步：死循环/长命令在子进程里跑，不再阻塞主 event loop（Esc 监听仍活着）
  //   2) 可中断：signal 一 abort 立刻收场
  // 用 node spawn 而非 Bun.spawn，是为了 detached:true —— 让 bash 自成「进程组」。
  // 否则 proc.kill() 只杀直接子进程 bash，孙子进程（如 sleep）会成孤儿继续持有
  // stdout 管道写端，管道不 EOF → 读取 await 永不返回（实测会傻等满 10s）。
  // process.kill(-pid) 的负号 = 杀掉整个进程组，bash + 它的所有后代一锅端。
  execute: ({ command }, signal) =>
    new Promise<string>((resolve) => {
      if (signal?.aborted) return resolve("[bash 已中断]")
      const proc = spawn("bash", ["-c", command], { detached: true }) // detached → 新进程组，pgid === pid
      let out = "", err = ""
      proc.stdout.on("data", (d) => (out += d))
      proc.stderr.on("data", (d) => (err += d))
      const onAbort = () => {
        try { process.kill(-proc.pid!, "SIGKILL") } catch {} // 负 pid = 杀整组；进程已退则忽略
        resolve("[bash 已中断]") // 立即收场，不等管道 EOF
      }
      signal?.addEventListener("abort", onAbort)
      proc.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort)
        if (signal?.aborted) return // 已被 onAbort 兑现过
        resolve(code === 0 ? (out || "(无输出)") : `[bash 失败] ${err || `exit ${code}`}`)
      })
      proc.on("error", (e) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(`[bash 失败] ${e.message}`)
      })
    }),
}

// 注册表：加新工具 = 往这里加一个，agent loop 一行都不用改。
export const tools: Tool[] = [read_file, write_file, edit_file, glob, grep, bash]
export const toolMap = new Map(tools.map((t) => [t.name, t]))
