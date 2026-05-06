import type { SkillRegistry } from "../core/skill.js";
import type { HomeDocuments } from "../home/index.js";
import fs from "fs";
import os from "os";
import path from "path";
import { buildBuiltinToolDirectoryLines } from "../runtime/tool_catalog.js";

/**
 * Build environment metadata block for the system prompt.
 * Gives the agent awareness of its own runtime context.
 */
export function buildEnvironmentMetadata(sessionId?: string): string {
  const pkg = safeReadJson(path.resolve(process.cwd(), "package.json"));
  const lines: string[] = [
    "===== 运行环境 (Environment) =====",
    `- Agent: pet-agent v${pkg?.version || "unknown"}`,
    `- 运行模式: ${getRuntimeMode()}`,
    `- 操作系统: ${os.type()} ${os.release()} (${os.arch()})`,
    `- Node.js: ${process.version}`,
    `- 项目目录: ${process.cwd()}`,
    `- 数据目录: ${process.env.HOME || "~"}/.PetAgent`,
    `- 会话 ID: ${sessionId || "unknown"}`,
    `- 默认语言: zh-CN`,
    `- 安全策略: exec 命令沙箱已启用（禁止 rm -rf / sudo / 危险命令）`,
    `- 读写范围: 项目目录 ~/clawd ~/.PetAgent/workspace /tmp`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Build skills index block for the system prompt.
 * Lists all loaded skills (user-created + third-party) with their triggers.
 */
export function buildSkillsIndex(skillList: ReturnType<SkillRegistry["listAll"]>): string {
  const userSkills = skillList.filter((s) => s.source === "user-created");
  const thirdParty = skillList.filter((s) => s.source === "third-party");
  const builtin = skillList.filter((s) => s.source === "builtin");

  const lines: string[] = ["===== 技能 (Skills) ====="];

  if (builtin.length > 0) {
    lines.push("");
    lines.push("### 内置技能");
    for (const s of builtin) {
      const cmds = s.commands.length ? `, commands: [${s.commands.join(", ")}]` : "";
      const hint = s.tool ? `, tool: \`${s.tool}\`` : "";
      lines.push(`- name: ${s.name}${cmds}${hint}`);
      lines.push(`  desc: ${s.description}`);
    }
  }

  if (userSkills.length > 0) {
    lines.push("");
    lines.push("### 用户创建技能");
    for (const s of userSkills) {
      const cmds = s.commands.length ? `, commands: [${s.commands.join(", ")}]` : "";
      lines.push(`- name: ${s.name}${cmds}`);
      lines.push(`  desc: ${s.description}`);
    }
  }

  if (thirdParty.length > 0) {
    lines.push("");
    lines.push("### 第三方技能");
    for (const s of thirdParty) {
      const cmds = s.commands.length ? `, commands: [${s.commands.join(", ")}]` : "";
      const author = s.author ? `, author: ${s.author}` : "";
      lines.push(`- name: ${s.name}${cmds}${author}`);
      lines.push(`  desc: ${s.description}`);
    }
  }

  if (builtin.length === 0 && userSkills.length === 0 && thirdParty.length === 0) {
    lines.push("\n- name: (none)");
    lines.push("  desc: 暂无加载的技能");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Build tool directory block for the system prompt.
 * Concise one-liner per tool — the actual tool definitions are passed
 * via the API `tools` parameter for native function calling.
 * This block is the LLM's quick reference for *when* to use each tool.
 *
 * Removed from here (no longer duplicated): full JSON schemas.
 */
export function buildToolDirectory(): string {
  return buildBuiltinToolDirectoryLines().join("\n");
}

/**
 * The system prompt is built from runtime user-data files, not from project-root files.
 * This keeps packaged installs and local development on the same model:
 * the agent always reads from a runtime workspace created by onboarding.
 *
 * System prompt structure (no redundant tool descriptions — tools are API-native):
 *   1. Role definition
 *   2. Environment metadata
 *   3. Skills index
 *   4. Tool directory (concise reference only, full schemas via API `tools` param)
 *   5. Role document (SOUL)
 *   6. Frozen Memory Snapshot
 *   7. Memory rules
 *   8. Response rules
 */
export function buildSystemPrompt(
  toolDirectory: string,
  envMetadata: string,
  skillsIndex: string,
  docs: HomeDocuments,
  memoryContext?: string,
): string {
  const parts: string[] = [
    "你是一位专业、富有爱心的宠物健康助手——「毛孩子健康顾问」🐾",
    "你是一个会主动思考并使用工具的 agent。请遵循 ReAct：先理解问题，再决定是否调用工具，拿到观察结果后再给出最终答复。",
    "",
  ];

  // 1. Environment metadata
  parts.push(envMetadata, "");

  // 2. Skills index
  parts.push(skillsIndex, "");

  // 3. Tool directory (concise reference, not full schemas)
  parts.push(toolDirectory);

  // 4. Home documents
  if (docs.soul) {
    parts.push("===== 角色灵魂 (SOUL.md) =====");
    parts.push(docs.soul, "");
  }

  // 5. Frozen Memory Snapshot
  if (memoryContext) {
    parts.push(
      "===== Frozen Memory Snapshot (预取于本轮开始) ====",
      memoryContext,
      "",
    );
  }

  // 6. Memory rules
  parts.push(
    "===== 记忆规则 =====",
    "- 你拥有内置记忆文件 `MEMORY.md`、`USER.md`、`DOMAIN.md`，它们会在 session 启动时读取并冻结成 snapshot 注入给你",
    "- 如果用户问「你了解我吗」或类似的回忆性问题，直接引用 Frozen Memory Snapshot 中的内容回答即可，这是你跨会话掌握的信息",
    "- 不用说你只在当前会话中记得这些，这些信息是持久化的，下次对话仍会加载",
    "- 发现值得跨会话保留的偏好、经验 -> 使用 `memory` 工具",
    "- 发现值得跨会话保留的领域知识 -> 也可以使用 `memory` 工具写入 `DOMAIN.md`",
    "- `memory` 适合保存稳定、长期、高价值的信息，例如用户偏好、反复验证有效的处理经验、长期业务规则、稳定身份信息",
    "- 临时寒暄、一次性上下文、低信息量短句通常不会进入长期检索记忆，不要为这些内容频繁调用 `memory`",
    "- 外置长期记忆由当前配置的 memory provider 维护；`memory_search` 会优先通过 provider 的检索能力召回跨会话记忆，而不是假设固定读取某个本地文件",
    "- 当你希望未来能被 `memory_search` 稳定召回时，应优先把信息整理成明确、可复用、去歧义的长期记忆再调用 `memory`",
    "- 需要回忆过去对话 -> 使用 `memory_search`（比 `session_search` 优先级高）",
    "",
  );

  // 7. Response rules
  parts.push(
    "## 回复规则",
    "- 回复格式友好易读，适当使用 emoji",
    "- 用药安全红线：人类止痛药/阿司匹林对猫狗有毒",
    "- 重要信息用**粗体**强调",
    "- 紧急情况（呼吸困难、严重出血、抽搐）-> 立即建议就医，不要绕弯",
  );

  return parts.join("\n");
}

// ── Helper: build skill catalog text (kept for backward compat) ──

export function buildSkillCatalog(skillList: ReturnType<SkillRegistry["listAll"]>): string {
  const lines: string[] = [];
  for (const s of skillList) {
    const cmds = s.commands.join(", ");
    const toolHint = s.tool ? ` -> 可调用 MCP 工具 \`${s.tool}\`` : "";
    lines.push(`- **${s.name}**${cmds ? ` (${cmds})` : ""}: ${s.description}${toolHint}`);
  }
  return lines.join("\n");
}

// ── Internal helpers ──

function getRuntimeMode(): string {
  const args = process.argv.slice(2).join(" ");
  if (args.includes("mcp")) return "MCP Server";
  if (args.includes("tui")) return "TUI";
  if (args.includes("gateway")) return "Gateway";
  return "CLI";
}

function safeReadJson(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
