/**
 * ThothAgent is now a thin facade over the runtime orchestrator.
 *
 * This keeps the external API stable for the CLI while moving the real
 * responsibilities into dedicated runtime/session/tool layers.
 */
import { AgentRuntime, type AgentRuntimeOptions } from "../runtime/index.js";

export class ThothAgent {
  readonly runtime: AgentRuntime;

  constructor(options: AgentRuntimeOptions = {}) {
    this.runtime = new AgentRuntime(options);
  }

  get memory() {
    return this.runtime.memory;
  }

  get llm() {
    return this.runtime.llm;
  }

  get mcp() {
    return this.runtime.mcp;
  }

  get skills() {
    return this.runtime.skills;
  }

  async think(userInput: string, imagePath?: string): Promise<string> {
    return this.thinkWithTrace(userInput, imagePath).then((result) => result.text);
  }

      async thinkWithTrace(
    userInput: string,
    imagePath?: string,
    onTrace?: Parameters<AgentRuntime["runTurn"]>[2],
  ) {
    return this.runtime.runTurn(userInput, imagePath, onTrace);
  }

  getWelcome(): string {
    const skills = this.skills.listAll();
    const lines = skills.slice(0, 8).map((s) =>
      `- **${s.commands[0] || s.name}** — ${s.description}`
    );
    return [
      `△ **ThothAgent** 已就位！`,
      ``,
      `## 可用命令`,
      lines.join("\n"),
      ``,
      `直接输入任务或问题，LLM 会智能决定是否调用工具。`,
      ``,
      `---`,
      ``,
      `**提示：** 输入 \`/tree\` 查看项目结构，输入 \`/history\` 查看历史记录`,
    ].join("\n");
  }

  getHelp(): string {
    const skills = this.skills.listAll();
    return [
      `## 📋 可用命令`,
      ...skills.map((s) => `- **${s.commands[0] || s.name}** — ${s.description}`),
      ``,
      `---`,
      `- 直接输入文字 — 通用垂直任务 / LLM 智能回答`,
      `- 发送图片 — 多模态理解与分析`,
      `- \`/tree\` — 查看项目结构`,
      `- \`/history\` — 查看会话历史`,
      `- \`/exit\` — 退出`,
    ].join("\n");
  }
}
