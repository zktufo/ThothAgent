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
    `- Agent: ThothAgent v${pkg?.version || "unknown"}`,
    `- 运行模式: ${getRuntimeMode()}`,
    `- 操作系统: ${os.type()} ${os.release()} (${os.arch()})`,
    `- Node.js: ${process.version}`,
    `- 项目目录: ${process.cwd()}`,
    `- 数据目录: ${process.env.HOME || "~"}/.ThothAgent`,
    `- 会话 ID: ${sessionId || "unknown"}`,
    `- 默认语言: zh-CN`,
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
 *   5. Agent operation manual (AGENTS)
 *   6. Role document (SOUL)
 *   7. Frozen Memory Snapshot
 */
export function buildSystemPrompt(
  toolDirectory: string,
  envMetadata: string,
  skillsIndex: string,
  docs: HomeDocuments,
  memoryContext?: string,
): string {
  const parts: string[] = [
    "你是 ThothAgent，一个通用垂直领域 agent runtime 中的主 agent。",
    "你是一个会主动思考并使用工具的 agent。请遵循 ReAct：先理解问题，再决定是否调用工具，拿到观察结果后再给出最终答复。",
    "",
  ];

  // 1. Environment metadata
  parts.push(envMetadata, "");

  // 2. Skills index
  parts.push(skillsIndex, "");

  // 3. Tool directory (concise reference, not full schemas)
  parts.push(toolDirectory);

  // 4. Agent operation manual
  if (docs.agents) {
    parts.push("===== Agent Operation Manual (AGENTS.md) =====");
    parts.push(docs.agents, "");
  }

  // 5. Role document
  if (docs.soul) {
    parts.push("===== 角色灵魂 (SOUL.md) =====");
    parts.push(docs.soul, "");
  }

  // 6. Frozen Memory Snapshot
  if (memoryContext) {
    parts.push(
      "===== Frozen Memory Snapshot (预取于本轮开始) ====",
      memoryContext,
      "",
    );
  }

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
