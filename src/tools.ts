import { execSync, execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type Anthropic from "@anthropic-ai/sdk"

// 工具的统一抽象：一份给模型看的「说明书」(name/description/input_schema)
// + 一个给代码用的「执行体」(execute)。两者合在一个对象里，但职责分明。
export interface Tool {
  name: string
  description: string
  input_schema: Anthropic.Tool["input_schema"]
  execute(input: any): string
}

const read_file: Tool = {
  name: "read_file",
  description: "读取指定文件的全部内容。",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "文件路径" } },
    required: ["path"],
  },
  execute: ({ path }) => {
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
  execute: ({ path, content }) => {
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
  execute: ({ path, old_string, new_string }) => {
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
  execute: ({ pattern }) => {
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
  execute: ({ query, path = "." }) => {
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
  execute: ({ command }) => {
    try { return execSync(command, { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }) || "(无输出)" }
    catch (e: any) { return `[bash 失败] ${e.stderr || e.message}` }
  },
}

// 注册表：加新工具 = 往这里加一个，agent loop 一行都不用改。
export const tools: Tool[] = [read_file, write_file, edit_file, glob, grep, bash]
export const toolMap = new Map(tools.map((t) => [t.name, t]))
