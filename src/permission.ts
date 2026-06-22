import type { Tool } from "./tools"

// 权限判定结果：放行 / 问用户 / 直接拒。
// 这是 agent「刹车」的核心 —— 在工具执行【之前】决定它能不能跑。
export type Decision = "allow" | "ask" | "deny"

// —— bash 命令分级（最小版用正则演示思路）——
// ⚠️ 重要的诚实：正则【不是】真安全。它挡得住直白的 `rm -rf`，挡不住绕过
//    （`r''m -rf`、变量拼接 `X=rm; $X -rf`、base64 解码后执行…）。
//    真正的命令安全做不到纯静态判定 —— 真 CC 也是「尽力检测 + 靠人审批兜底」。
//    所以策略是：能确信安全的放行、能确信危险的拒、【拿不准一律 ask 交给人】。

// 确信安全的只读命令：自动放行，不打扰用户
const SAFE_BASH =
  /^\s*(ls|pwd|cat|head|tail|wc|file|stat|echo|date|whoami|which|env|tree|du|df|cd|grep|rg|find|git\s+(status|diff|log|show|branch|remote))\b/

// 确信危险的命令：直接拒，连问都不问（避免「手滑按了 y」造成不可逆后果）
const DANGER_BASH =
  /(\brm\s+-[rf]|\bsudo\b|\bmkfs|\bdd\s+if=|:\(\)\s*\{\s*:|\bchmod\s+-R|\bchown\s+-R|>\s*\/dev\/(sd|disk|hd|nvme)|\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b|\bgit\s+push\b|\bnpm\s+publish\b|\b(shutdown|reboot|halt|poweroff)\b)/

// 权限门：给定「工具 + 这次的参数」，返回该放行 / 该问 / 该拒。
// 关键：判定对象是「工具 + 参数」而非「工具」—— 同一个 bash，`ls` 和 `rm -rf` 天差地别。
export function checkPermission(tool: Tool, input: any): Decision {
  // 只读工具（read_file / glob / grep）：永远放行
  if (tool.readOnly) return "allow"

  // bash：危险性全在「命令内容」里，必须解析参数而非看工具名
  if (tool.name === "bash") {
    const cmd = String(input?.command ?? "")
    if (DANGER_BASH.test(cmd)) return "deny"
    if (SAFE_BASH.test(cmd)) return "allow"
    return "ask" // 拿不准 → 交给人
  }

  // 其余有副作用的工具（write_file / edit_file）：问一次
  return "ask"
}
