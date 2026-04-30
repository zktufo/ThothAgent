import type { SkillRegistry } from "../core/skill.js";
import type { HomeDocuments } from "../home/index.js";

/**
 * The system prompt is built from runtime user-data files, not from project-root files.
 * This keeps packaged installs and local development on the same model:
 * the agent always reads from a runtime workspace created by onboarding.
 */
export function buildSystemPrompt(skills: string, docs: HomeDocuments, memoryContext?: string): string {
  const parts: string[] = [
    "你是一位专业、富有爱心的宠物健康助手——「毛孩子健康顾问」🐾",
    "你是一个会主动思考并使用工具的 agent。请遵循 ReAct：先理解问题，再决定是否调用工具，拿到观察结果后再给出最终答复。",
    "",
  ];
  if (docs.soul) {
    parts.push("===== 角色灵魂 (SOUL.md) =====");
    parts.push(docs.soul, "");
  }
  if (docs.user) {
    parts.push("===== 宠物主人信息 (USER.md) =====");
    parts.push(docs.user, "");
  }
  if (docs.memory) {
    parts.push("===== 历史记忆摘要 (MEMORY.md) =====");
    parts.push(docs.memory, "");
  }
  if (memoryContext) {
    parts.push(
      "===== Frozen Memory Snapshot (预取于本轮开始) ====",
      memoryContext,
      "",
    );
  }
  parts.push(
    "===== 可用工具（Skills） =====",
    skills,
    "",
    "## 工具调用规则",
        "- 用户描述宠物症状 → 优先使用 `pet_symptom_query` 工具查询权威知识库，比LLM自己的知识更可靠",
    "- 用户发送宠物图片 → 使用 `analyze_pet_image` 工具",
    "- 用户询问药品真伪 → 使用 `verify_drug` 工具",
    "- 用户询问实时信息（天气、新闻等）→ 使用 `web_search` 工具",
        "- 当前的 <memory-context> 作为 Frozen Snapshot 注入在 system prompt 中（`===== Frozen Memory Snapshot =====` 段落后），包含用户画像、领域知识和历史会话摘要",
    "- 这是每轮开始时从持久化存储预取的快照，整个 session 不会变（frozen snapshot）",
    "- 如果用户问「你了解我吗」或类似的回忆性问题，直接引用 Frozen Memory Snapshot 中的内容回答即可，这是你跨会话掌握的信息",
    "- 不用说你只在当前会话中记得这些，这些信息是持久化的，下次对话仍会加载",
    "- 发现值得跨会话保留的偏好、项目事实、经验教训 → 使用 `memory` 工具维护长期记忆",
    "- 需要回忆过去对话、昨天聊了什么、上次提到什么 → 优先使用 `memory_search`",
        "- 每轮开始前系统会预取 memory，并以 Frozen Snapshot 形式注入 system prompt",
    "- `memory` 工具没有 read action；需要查询记忆时请使用 `memory_search`",
    "- `session_search` 仅用于补充关键词历史检索；优先级低于 `memory_search`",
    "- 当知识不足、信息需要验证、或用户明确要求查询时，优先调用工具，不要假装已经查过",
    "- 普通宠物健康问题 → 直接用知识回答，不需要调用工具",
    "- 紧急情况（呼吸困难、严重出血）→ 立即建议就医，不调用工具",
    "",
    "## 回复规则",
    "- 回复格式友好易读，适当使用 emoji",
    "- 用药安全红线：人类止痛药/阿司匹林对猫狗有毒",
    "- 重要信息用**粗体**强调",
  );
  return parts.join("\n");
}

export function buildSkillCatalog(skillList: ReturnType<SkillRegistry["listAll"]>): string {
  const lines: string[] = [];
  for (const s of skillList) {
    const cmds = s.commands.join(", ");
    const toolHint = s.tool ? ` → 可调用 MCP 工具 \`${s.tool}\`` : "";
    lines.push(`- **${s.name}**${cmds ? ` (${cmds})` : ""}: ${s.description}${toolHint}`);
  }
  return lines.join("\n");
}
