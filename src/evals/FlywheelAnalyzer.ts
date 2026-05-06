/**
 * FlywheelAnalyzer — 工具调用飞轮分析器
 *
 * 从 SQLite actions 表读取工具调用数据，统计成功率/失败模式/趋势，
 * 产生优化建议，可选写入报告文件。
 *
 * 触发方式：按对话轮数间隔（非时间间隔）
 * 
 * 配置方式：~/.ThothAgent/ThothAgent.json 中的 flywheel 段
 *
 * ```json
 * {
 *   "flywheel": {
 *     "enabled": true,
 *     "analysisIntervalTurns": 3,
 *     "reportDir": "",
 *     "autoOptimize": false
 *   }
 * }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SQLiteSessionStore } from "../session/SQLiteSessionStore.js";

// ── 配置 ─────────────────────────────────────────────────────────────────────

export interface FlywheelConfig {
  enabled: boolean;
  /** 分析间隔（对话轮数），默认 1 = 每轮对话都分析 */
  analysisIntervalTurns: number;
  /** 报告输出目录，空则写入 agent 数据目录下的 flywheel/ */
  reportDir: string;
  /** 是否自动应用优化建议（谨慎！） */
  autoOptimize: boolean;
}

export const DEFAULT_FLYWHEEL_CONFIG: FlywheelConfig = {
  enabled: true,
  analysisIntervalTurns: 1,
  reportDir: "",
  autoOptimize: false,
};

// ── 分析结果类型 ─────────────────────────────────────────────────────────────

export interface ToolCallStats {
  toolName: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  /** 按错误信息分组的失败次数（取 top5） */
  errorPatterns: Array<{ error: string; count: number }>;
  /** 按 step 的成功率分布 */
  stepBreakdown: Array<{ step: number; total: number; success: number; successRate: number }>;
  /** 最近7天的调用趋势 */
  trend: Array<{ period: string; total: number; successRate: number }>;
}

export interface OptimizationSuggestion {
  toolName: string;
  severity: "high" | "medium" | "low";
  category: "description" | "parameter" | "implementation" | "safety" | "schedule";
  title: string;
  detail: string;
  /** 自动修复的具体建议 */
  fix?: string;
}

export interface FlywheelReport {
  id: string;
  generatedAt: string;
  config: Pick<FlywheelConfig, "analysisIntervalTurns" | "autoOptimize">;
  summary: {
    totalTools: number;
    totalCalls: number;
    overallSuccessRate: number;
    highRiskTools: number;
    suggestionsCount: number;
  };
  perTool: ToolCallStats[];
  suggestions: OptimizationSuggestion[];
}

// ── 分析器 ───────────────────────────────────────────────────────────────────

export class FlywheelAnalyzer {
  private config: FlywheelConfig;
  private turnCounter: number = 0;
  private lastRunTurn: number = 0;
  private reportCache: FlywheelReport | null = null;

  constructor(config?: Partial<FlywheelConfig>) {
    this.config = { ...DEFAULT_FLYWHEEL_CONFIG, ...(config || {}) };
  }

  /** 合并运行时配置（ThothAgent.json 的 flywheel 段覆盖） */
  applyConfig(userConfig: Partial<FlywheelConfig>): void {
    this.config = { ...this.config, ...userConfig };
  }

  getConfig(): Readonly<FlywheelConfig> {
    return this.config;
  }

  /** 返回当前已完成的对话轮数 */
  getTurnCount(): number {
    return this.turnCounter;
  }

  /** 返回从上一次分析到现在经过的轮数 */
  getTurnsSinceLastRun(): number {
    return this.turnCounter - this.lastRunTurn;
  }

  /** 本轮是否应该执行分析（基于轮数间隔判断） */
  shouldRun(): boolean {
    if (!this.config.enabled) return false;
    return this.getTurnsSinceLastRun() >= this.config.analysisIntervalTurns;
  }

  /** 获取上次分析结果缓存 */
  getLastReport(): FlywheelReport | null {
    return this.reportCache;
  }

  // ── 核心分析 ────────────────────────────────────────────────────────────

  async analyze(store: SQLiteSessionStore): Promise<FlywheelReport> {
    const t0 = performance.now();
    const report = await this.buildReport(store);
    report.id = crypto.randomUUID();
    report.generatedAt = new Date().toISOString();
    this.reportCache = report;
    this.lastRunTurn = this.turnCounter;

    // 写入报告文件（异步，不阻塞）
    this.writeReport(store, report).catch(() => {});

    console.log(
      `[Flywheel] 分析完成: ${report.perTool.length} 个工具, `
      + `${report.summary.totalCalls} 次调用, `
      + `成功率 ${(report.summary.overallSuccessRate * 100).toFixed(1)}%, `
      + `${report.summary.suggestionsCount} 条建议 `
      + `(${(performance.now() - t0).toFixed(0)}ms)`,
    );

    return report;
  }

  // ── 运行时集成 ──────────────────────────────────────────────────────────

  /**
   * 每轮对话完成后调用此方法。
   * 内部自动更新轮数计数器，并在达到间隔时执行分析。
   *
   * 用法（在 finalizeTurn 末尾调用）：
   *   this.flywheel.onTurnComplete(this.sessions.store);
   */
  onTurnComplete(store: SQLiteSessionStore): void {
    if (!this.config.enabled) return;
    this.turnCounter++;

    if (this.shouldRun()) {
      // 异步执行，不阻塞对话响应
      this.analyze(store).catch((err) => {
        console.error(`[Flywheel] 分析失败: ${err}`);
      });
    }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  private async buildReport(store: SQLiteSessionStore): Promise<FlywheelReport> {
    const { db } = (store as any);
    if (!db || typeof db.prepare !== "function") {
      return this.buildFromMessages(store);
    }

    // ── 首选：actions 表 ──
    const tools = this.collectToolNames(db);
    const perTool: ToolCallStats[] = [];
    const allSuggestions: OptimizationSuggestion[] = [];
    let totalCalls = 0;
    let totalSuccess = 0;

    for (const toolName of tools) {
      const stats = this.collectToolStats(db, toolName);
      perTool.push(stats);
      totalCalls += stats.total;
      totalSuccess += stats.success;

      const suggestions = this.generateSuggestions(stats);
      for (const s of suggestions) {
        allSuggestions.push(s);
      }
    }

    return {
      id: "",
      generatedAt: "",
      config: {
        analysisIntervalTurns: this.config.analysisIntervalTurns,
        autoOptimize: this.config.autoOptimize,
      },
      summary: {
        totalTools: perTool.length,
        totalCalls,
        overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
        highRiskTools: perTool.filter((t) => t.successRate < 0.7).length,
        suggestionsCount: allSuggestions.length,
      },
      perTool,
      suggestions: allSuggestions,
    };
  }

  /**
   * Fallback：messages 表中 role='tool' 的记录
   * 当 actions 表不存在或没有数据时自动切换
   */
  private async buildFromMessages(store: SQLiteSessionStore): Promise<FlywheelReport> {
    const { db } = (store as any);
    const toolNames = this.collectToolNamesFromMessages(db);
    const perTool: ToolCallStats[] = [];
    const allSuggestions: OptimizationSuggestion[] = [];
    let totalCalls = 0;
    let totalSuccess = 0;

    for (const toolName of toolNames) {
      const stats = this.collectToolStatsFromMessages(db, toolName);
      perTool.push(stats);
      totalCalls += stats.total;
      totalSuccess += stats.success;

      const suggestions = this.generateSuggestions(stats);
      for (const s of suggestions) {
        allSuggestions.push(s);
      }
    }

    return {
      id: "",
      generatedAt: "",
      config: {
        analysisIntervalTurns: this.config.analysisIntervalTurns,
        autoOptimize: this.config.autoOptimize,
      },
      summary: {
        totalTools: perTool.length,
        totalCalls,
        overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
        highRiskTools: perTool.filter((t) => t.successRate < 0.7).length,
        suggestionsCount: allSuggestions.length,
      },
      perTool,
      suggestions: allSuggestions,
    };
  }

  // ── DB 查询（actions 表） ──────────────────────────────────────────────

  private collectToolNames(db: DatabaseSync): string[] {
    try {
      const rows = db.prepare(`
        SELECT DISTINCT tool_name
        FROM actions
        WHERE tool_name IS NOT NULL AND tool_name != ''
        ORDER BY tool_name
      `).all() as Array<{ tool_name: string }>;
      return rows.map((r) => r.tool_name);
    } catch {
      return [];
    }
  }

  private collectToolStats(db: DatabaseSync, toolName: string): ToolCallStats {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN output_status = 'success' THEN 1 ELSE 0 END) AS success
      FROM actions
      WHERE tool_name = ?
    `).get(toolName) as { total: number; success: number };

    const total = Number(totalRow?.total || 0);
    const success = Number(totalRow?.success || 0);
    const failed = total - success;

    // 错误模式
    const errRows = db.prepare(`
      SELECT output_summary, COUNT(*) AS count
      FROM actions
      WHERE tool_name = ? AND output_status != 'success' AND output_status IS NOT NULL
      GROUP BY output_summary
      ORDER BY count DESC
      LIMIT 5
    `).all(toolName) as Array<{ output_summary: string | null; count: number }>;

    const errorPatterns = errRows
      .filter((r) => r.output_summary)
      .map((r) => ({ error: r.output_summary!, count: Number(r.count) }));

    // 7天趋势
    const trend: ToolCallStats["trend"] = [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const dayRows = db.prepare(`
        SELECT DATE(created_at) AS day,
               COUNT(*) AS total,
               SUM(CASE WHEN output_status = 'success' THEN 1 ELSE 0 END) AS success
        FROM actions
        WHERE tool_name = ? AND created_at >= ?
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `).all(toolName, sevenDaysAgo) as Array<{ day: string; total: number; success: number }>;

      for (const r of dayRows) {
        const d = Number(r.total);
        trend.push({
          period: r.day,
          total: d,
          successRate: d > 0 ? Number(r.success) / d : 1,
        });
      }
    } catch {
      // 趋势查询非关键，静默跳过
    }

    // 按 step 成功率分布
    const stepBreakdown: ToolCallStats["stepBreakdown"] = [];
    try {
      const stepRows = db.prepare(`
        SELECT step,
               COUNT(*) AS total,
               SUM(CASE WHEN output_status = 'success' THEN 1 ELSE 0 END) AS success
        FROM actions
        WHERE tool_name = ? AND step IS NOT NULL
        GROUP BY step
        ORDER BY step ASC
      `).all(toolName) as Array<{ step: number; total: number; success: number }>;
      for (const r of stepRows) {
        const d = Number(r.total);
        stepBreakdown.push({
          step: Number(r.step),
          total: d,
          success: Number(r.success),
          successRate: d > 0 ? Number(r.success) / d : 1,
        });
      }
    } catch {
      // step 查询非关键
    }

    return {
      toolName,
      total,
      success,
      failed,
      successRate: total > 0 ? success / total : 1,
      errorPatterns,
      stepBreakdown,
      trend,
    };
  }

  // ── DB 查询（messages 表 fallback） ────────────────────────────────────

  private collectToolNamesFromMessages(db: DatabaseSync): string[] {
    try {
      const rows = db.prepare(`
        SELECT DISTINCT tool_name
        FROM messages
        WHERE role = 'tool' AND tool_name IS NOT NULL AND tool_name != ''
        ORDER BY tool_name
      `).all() as Array<{ tool_name: string }>;
      return rows.map((r) => r.tool_name);
    } catch {
      return [];
    }
  }

  private collectToolStatsFromMessages(db: DatabaseSync, toolName: string): ToolCallStats {
    const rows = db.prepare(`
      SELECT content, content_summary, metadata_json, created_at
      FROM messages
      WHERE role = 'tool' AND tool_name = ?
      ORDER BY created_at DESC
    `).all(toolName) as Array<{
      content: string | null;
      content_summary: string | null;
      metadata_json: string | null;
      created_at: string;
    }>;

    let success = 0;
    let failed = 0;
    const errorMap = new Map<string, number>();

    for (const row of rows) {
      let meta: Record<string, any> = {};
      try {
        meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
      } catch { /* ignore */ }

      if (meta.success === true) {
        success++;
      } else if (meta.success === false) {
        failed++;
        const err = (meta.error as string) || row.content_summary || row.content || "unknown_error";
        const key = err.length > 80 ? err.slice(0, 80) + "..." : err;
        errorMap.set(key, (errorMap.get(key) || 0) + 1);
      } else {
        // 无法判断则保守计为成功
        success++;
      }
    }

    const total = rows.length;

    // 趋势
    const trend: ToolCallStats["trend"] = [];
    const dayBuckets = new Map<string, { total: number; success: number }>();
    for (const row of rows) {
      const day = row.created_at.slice(0, 10);
      const b = dayBuckets.get(day) || { total: 0, success: 0 };
      b.total++;
      let meta: Record<string, any> = {};
      try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch { /* ignore */ }
      if (meta.success !== false) b.success++;
      dayBuckets.set(day, b);
    }
    for (const [day, b] of dayBuckets) {
      trend.push({ period: day, total: b.total, successRate: b.total > 0 ? b.success / b.total : 1 });
    }
    trend.sort((a, b) => a.period.localeCompare(b.period));

    return {
      toolName,
      total,
      success,
      failed,
      successRate: total > 0 ? success / total : 1,
      errorPatterns: Array.from(errorMap.entries()).map(([error, count]) => ({ error, count })),
      stepBreakdown: [], // messages 表无 step 信息
      trend,
    };
  }

  // ── 优化建议生成 ────────────────────────────────────────────────────────

  private generateSuggestions(stats: ToolCallStats): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // 1. 成功率太低的工具
    if (stats.total >= 5 && stats.successRate < 0.7) {
      suggestions.push({
        toolName: stats.toolName,
        severity: "high",
        category: "implementation",
        title: `${stats.toolName} 成功率偏低 (${(stats.successRate * 100).toFixed(0)}%)`,
        detail: [
          `共调用 ${stats.total} 次，失败 ${stats.failed} 次`,
          ...stats.errorPatterns.slice(0, 3).map(
            (e) => `- 高频错误: "${e.error}" (${e.count}次)`,
          ),
        ].join("\n"),
        fix: this.suggestFix(stats),
      });
    }

    // 2. 下降趋势
    if (stats.trend.length >= 3) {
      const recent = stats.trend.slice(-3);
      const firstRate = recent[0].successRate;
      const lastRate = recent[recent.length - 1].successRate;
      if (firstRate > 0.8 && lastRate < 0.6) {
        suggestions.push({
          toolName: stats.toolName,
          severity: "medium",
          category: "implementation",
          title: `${stats.toolName} 近期成功率持续下降`,
          detail: `${recent[0].period} ${(firstRate * 100).toFixed(0)}% → ${recent[recent.length - 1].period} ${(lastRate * 100).toFixed(0)}%`,
        });
      }
    }

    // 3. 调用太少（可能没用上）
    if (stats.total < 3 && stats.total > 0) {
      suggestions.push({
        toolName: stats.toolName,
        severity: "low",
        category: "description",
        title: `${stats.toolName} 调用次数偏少 (${stats.total}次)`,
        detail: "可能 LLM 没有正确触发该工具，考虑检查 tool description 是否清晰、trigger condition 是否合理",
        fix: `重新检查 tool catalog 中 ${stats.toolName} 的 description 和 when 字段`,
      });
    }

    // 4. 零调用
    if (stats.total === 0) {
      suggestions.push({
        toolName: stats.toolName,
        severity: "medium",
        category: "schedule",
        title: `${stats.toolName} 从未被调用`,
        detail: "可能未被注册到 LLM tool catalog，或被更高优先级的工具覆盖",
        fix: "检查 BUILTIN_TOOL_SPECS 中的 priority 和注册逻辑",
      });
    }

    // 5. 按 step 分析：是否某些步骤特别容易失败
    if (stats.stepBreakdown.length >= 2) {
      const highRiskSteps = stats.stepBreakdown.filter(
        (s) => s.total >= 3 && s.successRate < 0.6,
      );
      if (highRiskSteps.length > 0) {
        suggestions.push({
          toolName: stats.toolName,
          severity: "medium",
          category: "implementation",
          title: `${stats.toolName} 在第 ${highRiskSteps.map((s) => s.step).join("、")} 步成功率偏低`,
          detail: highRiskSteps.map(
            (s) => `- step ${s.step}: ${s.total}次调用，成功率 ${(s.successRate * 100).toFixed(0)}%`,
          ).join("\n"),
          fix: `第 ${highRiskSteps[0].step} 步失败率高，可能是该工具在 ReAct 循环的后续轮次中上下文不够完整。考虑优化 prompt，让 LLM 在首次调用就获取足够信息，减少重试`,
        });
      }
    }

    return suggestions;
  }

  private suggestFix(stats: ToolCallStats): string {
    if (stats.errorPatterns.length === 0) return "无具体错误信息，需手动检查实现";

    const topError = stats.errorPatterns[0].error.toLowerCase();

    if (topError.includes("missing") || topError.includes("require")) {
      return `检查 ${stats.toolName} 的 input_schema，看是否有必填参数未正确传递或 LLM 未填充`;
    }
    if (topError.includes("timeout") || topError.includes("timed out")) {
      return `${stats.toolName} 执行超时，考虑加超时重试或缩短处理流程`;
    }
    if (topError.includes("not found") || topError.includes("not exist")) {
      return `${stats.toolName} 查找的资源不存在，考虑增加 fallback 或更友好的错误提示`;
    }
    if (topError.includes("permission") || topError.includes("denied") || topError.includes("unauthorized")) {
      return `${stats.toolName} 权限不足，检查工具沙箱策略或 API 凭据`;
    }
    if (topError.includes("invalid") || topError.includes("bad")) {
      return `${stats.toolName} 参数校验失败，建议在工具实现中增加更明确的参数校验和错误提示`;
    }

    return `高频错误: "${stats.errorPatterns[0].error}"。建议先排查实现代码，必要时在 tool description 中补充更清晰的调用指引`;
  }

  // ── 报告写入 ────────────────────────────────────────────────────────────

  private async writeReport(store: SQLiteSessionStore, report: FlywheelReport): Promise<void> {
    const { homePaths } = (store as any);
    if (!homePaths) return;

    const reportDir = this.config.reportDir
      ? path.resolve(this.config.reportDir)
      : path.join(homePaths.agentRoot, "flywheel");

    fs.mkdirSync(reportDir, { recursive: true });

    // 最新报告（覆盖）
    const reportPath = path.join(reportDir, "latest.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    // 带时间戳的历史报告
    const dateStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const historyPath = path.join(reportDir, `flywheel-${dateStamp}.json`);
    fs.writeFileSync(historyPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    // 人类可读的摘要
    const summaryPath = path.join(reportDir, "summary.md");
    fs.writeFileSync(summaryPath, this.formatMarkdownSummary(report), "utf-8");
  }

  private formatMarkdownSummary(report: FlywheelReport): string {
    const lines: string[] = [
      `# 🌀 Flywheel 工具调用分析报告`,
      ``,
      `**生成时间**: ${report.generatedAt}`,
      `**总工具数**: ${report.summary.totalTools}`,
      `**总调用次数**: ${report.summary.totalCalls}`,
      `**综合成功率**: ${(report.summary.overallSuccessRate * 100).toFixed(1)}%`,
      `**高风险工具**: ${report.summary.highRiskTools} 个`,
      `**优化建议**: ${report.summary.suggestionsCount} 条`,
      ``,
      `---`,
      ``,
      `## 📊 工具统计`,
      ``,
      `| 工具名 | 调用数 | 成功 | 失败 | 成功率 | 高风险 |`,
      `|-------|--------|------|------|--------|--------|`,
    ];

    for (const t of report.perTool) {
      const highRisk = t.successRate < 0.7 ? "⚠️" : "";
      lines.push(
        `| ${t.toolName} | ${t.total} | ${t.success} | ${t.failed} `
        + `| ${(t.successRate * 100).toFixed(1)}% | ${highRisk} |`,
      );

      // 有 step 分布数据时补充明细
      if (t.stepBreakdown.length >= 2) {
        const stepSummary = t.stepBreakdown
          .map((s) => `step${s.step}: ${(s.successRate * 100).toFixed(0)}%(${s.success}/${s.total})`)
          .join(" | ");
        lines.push(`| &nbsp;↳ step | ${stepSummary} | |`);
      }
    }

    if (report.suggestions.length > 0) {
      lines.push(
        ``,
        `---`,
        ``,
        `## 🔧 优化建议`,
        ``,
      );
      for (const s of report.suggestions) {
        const sev = s.severity === "high" ? "🔴" : s.severity === "medium" ? "🟡" : "🟢";
        lines.push(
          `### ${sev} [${s.severity}] ${s.toolName} — ${s.title}`,
          ``,
          s.detail,
          s.fix ? `\n> 💡 ${s.fix}` : "",
          ``,
        );
      }
    }

    lines.push(
      ``,
      `---`,
      `*报告ID: ${report.id}*`,
    );

    return lines.join("\n");
  }

  // ── 配置文件读写 ────────────────────────────────────────────────────────

  /**
   * 从 ThothAgent.json 加载 flywheel 配置段
   */
  static loadConfig(homeRoot: string): FlywheelConfig {
    const configPath = path.join(homeRoot, "ThothAgent.json");
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const fc = raw?.flywheel;
      if (!fc || typeof fc !== "object") return { ...DEFAULT_FLYWHEEL_CONFIG };

      return {
        enabled: typeof fc.enabled === "boolean" ? fc.enabled : DEFAULT_FLYWHEEL_CONFIG.enabled,
        analysisIntervalTurns: typeof fc.analysisIntervalTurns === "number"
          ? fc.analysisIntervalTurns
          : DEFAULT_FLYWHEEL_CONFIG.analysisIntervalTurns,
        reportDir: typeof fc.reportDir === "string" ? fc.reportDir : DEFAULT_FLYWHEEL_CONFIG.reportDir,
        autoOptimize: typeof fc.autoOptimize === "boolean" ? fc.autoOptimize : DEFAULT_FLYWHEEL_CONFIG.autoOptimize,
      };
    } catch {
      return { ...DEFAULT_FLYWHEEL_CONFIG };
    }
  }

  /**
   * 将 flywheel 配置写入 ThothAgent.json
   */
  static saveConfig(homeRoot: string, config: FlywheelConfig): void {
    const configPath = path.join(homeRoot, "ThothAgent.json");
    let root: Record<string, any> = {};
    try {
      root = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      root = { meta: { version: "1.0.0", lastTouchedAt: new Date().toISOString() } };
    }

    root.flywheel = {
      enabled: config.enabled,
      analysisIntervalTurns: config.analysisIntervalTurns,
      reportDir: config.reportDir,
      autoOptimize: config.autoOptimize,
    };
    root.meta = root.meta || {};
    root.meta.lastTouchedAt = new Date().toISOString();

    fs.writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
  }
}

export default FlywheelAnalyzer;
