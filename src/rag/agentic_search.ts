/**
 * Agentic Search — 智能体搜索策略引擎
 *
 * 让 LLM 像人类一样"多步搜索、自主判断"：
 * 1. 分析用户问题 → 拆解搜索意图
 * 2. 尝试搜索 → 评估结果质量
 * 3. 结果不足 → 调整搜索词/追加搜索
 * 4. 多源交叉验证 → 给出带推理链的回答
 *
 * 不依赖 LLM API 调用（避免循环成本），
 * 纯用规则引擎模拟 agent 的搜索策略。
 */
import { initPetRag } from "./orchestrator.js";
import { tokenizeForEmbedding } from "../memory/utils.js";
import type { RagSearchResult } from "./types.js";

interface SearchStep {
  query: string;
  results: RagSearchResult[];
  score: number; // 0-100 评估结果质量
  insight: string; // 从结果中归纳的见解
}

interface SearchPlan {
  originalQuery: string;
  steps: SearchStep[];
  finalAnswer: string;
  confidence: "high" | "medium" | "low";
  needsFollowUp: boolean;
  followUpQuestion?: string;
}

export class AgenticSearcher {
  /**
   * 执行 agentic search
   */
  async search(query: string, topK: number = 3): Promise<SearchPlan> {
    const plan: SearchPlan = {
      originalQuery: query,
      steps: [],
      finalAnswer: "",
      confidence: "high",
      needsFollowUp: false,
    };

    // Step 1: 分析问题，生成初始搜索词
    const searchQueries = this.generateSearchQueries(query);

    // Step 2: 多步搜索
    for (const sq of searchQueries) {
      const step = await this.executeSearchStep(sq);
      plan.steps.push(step);
    }

    // Step 3: 评估结果，判断是否需要追搜
    this.evaluateResults(plan);

    // Step 4: 如果需要追搜，生成 follow-up
    if (plan.needsFollowUp) {
      plan.followUpQuestion = this.generateFollowUp(plan);
    }

    // Step 5: 格式化答案
    plan.finalAnswer = this.formatFinalAnswer(plan);

    return plan;
  }

  /**
   * 格式化搜索结果供 LLM 使用（含推理链）
   */
  formatForPrompt(plan: SearchPlan): string {
    const lines: string[] = [
      "<agentic-search>",
      "",
      `用户问题: ${plan.originalQuery}`,
      `置信度: ${plan.confidence}`,
      "",
      "=== 搜索推理链 ===",
      "",
    ];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      lines.push(`[Step ${i + 1}] 搜索: "${step.query}"`);
      lines.push(`  匹配 ${step.results.length} 条`);
      lines.push(`  质量评分: ${step.score}/100`);
      if (step.insight) {
        lines.push(`  分析: ${step.insight}`);
      }
      lines.push("");
    }

    lines.push("=== 结论 ===");
    lines.push(plan.finalAnswer);

    if (plan.needsFollowUp && plan.followUpQuestion) {
      lines.push("");
      lines.push("=== 需要更多信息 ===");
      lines.push(plan.followUpQuestion);
    }

    lines.push("</agentic-search>");
    return lines.join("\n");
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 根据用户问题生成多个搜索策略词
   *
   * 策略：
   * 1. 原词搜索
   * 2. 提取核心症状词精简搜索
   * 3. 尝试同义词/上位词
   */
  private generateSearchQueries(query: string): string[] {
    const queries: string[] = [query];

    // 提取核心症状词
    const symptomPatterns = [
      /(吐了|呕吐|拉稀|腹泻|便秘|不拉|不吃|发烧|咳嗽|打喷嚏|流鼻涕|喘|痒|抓|脱毛|掉毛)/,
      /(尿不出|血尿|尿频|乱尿|口臭|流口水|眼睛红|眼屎|耳朵臭|甩头)/,
      /(抽搐|瘸了|不走路|肿了|流血|受伤|咬伤)/,
      /(疫苗|驱虫|洗澡|美容|绝育|怀孕|生产)/,
    ];

    for (const pattern of symptomPatterns) {
      const match = query.match(pattern);
      if (match) {
        // 精简搜索：只保留核心症状
        queries.push(match[1]);
        // 带品种（如果有）
        const breed = this.detectBreed(query);
        if (breed) {
          queries.push(`${breed} ${match[1]}`);
        }
        break;
      }
    }

    // 通用查询 fallback
    const genericTerms = [
      ["怎么办", "怎么处理", "怎么治", "如何"],
      ["原因", "为什么"],
      ["药", "吃什么药", "用什么药"],
    ];
    for (const terms of genericTerms) {
      if (terms.some((t) => query.includes(t))) {
        const symptom = this.extractSymptom(query);
        if (symptom && queries.length < 5) {
          queries.push(`${symptom} 治疗`);
          queries.push(`${symptom} 原因`);
        }
        break;
      }
    }

    // 去重
    return [...new Set(queries)].filter(Boolean).slice(0, 4);
  }

  /**
   * 执行单步搜索
   */
  private async executeSearchStep(query: string): Promise<SearchStep> {
    const rag = initPetRag();
    const results = await rag.search({ query, topK: 5 });

    const score = this.evaluateStepQuality(query, results);
    const insight = this.extractInsight(results);

    return { query, results, score, insight };
  }

  /**
   * 评估搜索结果质量
   * - 0: 完全无关
   * - 100: 精准命中
   */
  private evaluateStepQuality(query: string, results: RagSearchResult[]): number {
    if (!results.length) return 0;

    const queryTokens = tokenizeForEmbedding(query);
    let maxScore = 0;

    for (const result of results) {
      const textTokens = tokenizeForEmbedding(result.chunk.text);
            const overlap = queryTokens.filter((t: string) => textTokens.includes(t)).length;
      const ratio = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
      maxScore = Math.max(maxScore, Math.round(ratio * 100));
    }

    return maxScore;
  }

  /**
   * 从检索结果中提取关键洞察
   */
  private extractInsight(results: RagSearchResult[]): string {
    if (!results.length) return "未找到相关信息。";

    const top = results[0];
    if (!top) return "未找到相关信息。";

    // 取前几句作为洞察
        const lines = top.chunk.text.split("\n").filter((l: string) => {
      const t = l.trim();
      return t && !t.startsWith("#") && !t.startsWith("|") && t.length > 6;
    });

    return lines.slice(0, 3).join("；") || top.chunk.text.slice(0, 100);
  }

  /**
   * 评估是否需要更多信息
   */
  private evaluateResults(plan: SearchPlan): void {
    const bestScore = Math.max(...plan.steps.map((s) => s.score));
    const hasResults = plan.steps.some((s) => s.results.length > 0);

    if (!hasResults) {
      plan.confidence = "low";
      plan.needsFollowUp = true;
      return;
    }

    if (bestScore < 30) {
      plan.confidence = "low";
      plan.needsFollowUp = true;
    } else if (bestScore < 60) {
      plan.confidence = "medium";
    } else {
      plan.confidence = "high";
    }
  }

  /**
   * 生成追问
   */
  private generateFollowUp(plan: SearchPlan): string {
    const query = plan.originalQuery;

    // 根据缺失的信息生成追问
    const missingSymptom = [
      /(怎么办|怎么治|如何处理)/.test(query) && !/(发烧|呕吐|拉稀|咳嗽|不吃|不喝)/.test(query),
    ];

    if (missingSymptom[0]) {
      return "请描述更具体的症状，比如是什么品种的宠物、出现了什么异常表现？";
    }

    if (/(呕吐|拉稀|腹泻)/.test(query)) {
      return "方便告诉我持续时间吗？有没有伴随其他症状比如精神不好、不吃东西？";
    }

    if (/(皮肤|痒|脱毛)/.test(query)) {
      return "痒的部位在哪里？皮肤有没有发红、脱毛、结痂？";
    }

    return "可以提供更多细节吗？比如宠物种类、年龄、症状持续多久了？";
  }

  /**
   * 格式化最终答案
   */
  private formatFinalAnswer(plan: SearchPlan): string {
    const bestStep = plan.steps.reduce((best, s) =>
      s.score > (best?.score || 0) ? s : best,
      plan.steps[0],
    );

    if (!bestStep || !bestStep.results.length) {
      return "未找到相关领域知识。建议咨询兽医。";
    }

    const top = bestStep.results[0];
    const text = top.chunk.text;
    const source = top.chunk.source;

        const lines = text.split("\n").filter((l: string) => {
      const t = l.trim();
      return t && t !== "---" && !t.startsWith("```");
    });

    const summary = lines.slice(0, 8).join("\n");

    const sourceNote = source ? `\n\n（来源：${source}）` : "";
    return `${summary}${sourceNote}`;
  }

  private detectBreed(query: string): string | null {
    const breeds = ["比熊", "金毛", "拉布拉多", "法斗", "英斗", "巴哥", "博美", "吉娃娃", "柯基", "哈士奇", "萨摩", "泰迪", "贵宾", "布偶", "英短", "美短", "暹罗", "橘猫", "田园猫"];
    for (const breed of breeds) {
      if (query.includes(breed)) return breed;
    }
    return null;
  }

  private extractSymptom(text: string): string {
    const commonSymptoms = ["呕吐", "拉稀", "便秘", "咳嗽", "打喷嚏", "发烧", "不吃", "尿血", "瘸", "抖", "喘", "吐", "痒"];
    for (const s of commonSymptoms) {
      if (text.includes(s)) return s;
    }
    return text.slice(0, 6);
  }
}
