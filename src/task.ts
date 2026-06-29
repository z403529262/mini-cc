import type Anthropic from "@anthropic-ai/sdk"
import type { Tool } from "./tools"
import { runAgent } from "./agent"

// ============================================================================
// task 工具 —— 把「一整个子 agent」包装成一个普通的 Tool，塞进主 agent 的工具表。
//
// 这正是 D6 验证过的「注册表 + 权限门正交」的复用：MCP 工具能这么塞，子 agent 也能。
// 对主 loop 而言，task 和 read_file 没有区别 —— 都是 toolMap 里一个有 execute 的对象。
// 区别只在 execute 内部：task 的 execute = 用一套受限工具、一条全新的 messages，
// 再调一次 runAgent，把子 agent 跑出来的「最终汇报」当作工具结果返回。
// 主 loop 只看到那段汇报，子 agent 中间读的一堆文件全留在子上下文里 —— 这就是上下文隔离。
// ============================================================================

const SUBAGENT_SYSTEM =
  "你是被主 agent 派出的子 agent(调研 worker)。专注完成交代的任务：用只读工具(read_file/glob/grep)搜集信息，" +
  "然后用简洁中文【结论先行】汇报 —— 先给结论，再列关键文件/发现。不要复述读取过程、不要寒暄、不要反问、不要建议下一步。"

// 选出给子 agent 的工具集：只读 / MCP 工具放行，显式剔除 task 自己。
//   ① 只读工具 —— 子 agent 不改文件，checkPermission 全 allow，可全自动跑完不卡审批
//      (子 agent 跑在工具调用里，没有终端可以弹 y/n)
//   ② MCP 工具放行 —— MCP 是用户【主动接入】的外部能力，子 agent 调研时常要用(查 GitHub /
//      索引代码…)。哪怕它 readOnly:false 也放行，否则"只读一刀切"会把它误伤 = 负向优化。
//      对应 cc-haha filterToolsForAgent 的第一道闸：`mcp__` 前缀直接放行(agentToolUtils.ts:83)。
//      (可见≠可执行：放行只是进工具表，有副作用的那次调用仍要过权限门。)
//   ③ 递归防护 —— 剔除 task，子 agent 的工具表里根本没有 task，就无法再派生子 agent。
// ⚠️ `t.name !== "task"` 不可省：task 自身 readOnly:true，会被 `t.readOnly` 选中！
//    这半个条件才是递归防护那一刀。对应 cc-haha 剔除 AGENT_TOOL_NAME(agentToolUtils.ts:94)。
export function selectSubagentTools(parentTools: Tool[]): Tool[] {
  return parentTools.filter((t) => (t.readOnly || t.name.startsWith("mcp__")) && t.name !== "task")
}

export function makeTaskTool(opts: { client: Anthropic; model: string; parentTools: Tool[] }): Tool {
  const { client, model, parentTools } = opts
  return {
    name: "task",
    // 子 agent 只读、无副作用 → 派生它本身是安全的 → 自动放行，不打扰用户。
    // (若哪天给子 agent 配了写工具，这里就该改 false 过 ask 门 —— 权限随能力走。)
    readOnly: true,
    description:
      "派生一个【独立上下文】的子 agent 去完成一个相对独立的调研/搜索子任务。" +
      "子 agent 用只读工具自主探索，跑完只把【最终结论】回传 —— 它中间读的大量文件不会占用你的上下文。" +
      "适合：搜遍代码库找东西、调研某个模块、汇总分散信息。" +
      "给它清晰、自包含的 prompt(它看不到你的对话历史)。",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "任务的 3-5 字简述" },
        prompt: { type: "string", description: "交给子 agent 的完整任务(必须自包含，它看不到主对话)" },
      },
      required: ["description", "prompt"],
    },
    execute: async (input: any, signal) => {
      const prompt = String(input?.prompt ?? "")
      const desc = String(input?.description ?? "子任务")
      if (!prompt) return "[task 失败] 缺少 prompt"

      const subTools = selectSubagentTools(parentTools)
      const subMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }] // 全新、与主 messages 物理隔离

      console.log(`\n🔬 子 agent 启动｜${desc}（工具：${subTools.map((t) => t.name).join(", ")}）`)
      const result = await runAgent({
        client,
        model,
        system: SUBAGENT_SYSTEM,
        tools: subTools,
        messages: subMessages, // ← 隔离的关键：子 agent 在它自己的 messages 上循环，跑完即弃
        approve: () => true, // 只读集本不触发 ask，这里只是兜底
        signal, // 继承主的中断信号：主 Esc → 子也停
        maxTurns: 15,
        label: "sub",
        verbose: true, // 打印 [sub] 过程 —— 演示「这些都没进主 messages」
      })
      console.log(`✅ 子 agent 完成（${result.turns} 轮）→ 回传 ${result.text.length} 字结论\n`)

      // 只把「最终汇报」交回主 loop。中间过程(subMessages 里那一堆)随这次 execute 结束被丢弃。
      return result.text || "(子 agent 无文本输出)"
    },
  }
}
