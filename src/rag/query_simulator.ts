import { initPetRag } from "./orchestrator.js";
import { AgenticSearcher } from "./agentic_search.js";

export interface SimulatedQuery {
  id: string;
  query: string;
  intent: string;
  expectedTopics: string[];
  difficulty: "direct" | "vague" | "implied";
  variationOf?: string;
}

export interface SimulationReport {
  totalGenerated: number;
  totalHits: number;
  hitRate: number;
  byDifficulty: Record<string, { total: number; hits: number }>;
  topMissed: string[];
  generatedAt: string;
  dataPath: string;
}

/**
 * 从知识库文档中提取所有关键词作为模拟查询的种子
 */
const SEED_TERMS: Array<[string, string[]]> = [
  ["呕吐", ["消化系统", "急救"]], ["拉肚子", ["消化系统"]], ["腹泻", ["消化系统"]],
  ["拉稀", ["消化系统"]], ["软便", ["消化系统"]], ["便秘", ["消化系统"]],
  ["不吃东西", ["消化系统", "急救"]], ["没胃口", ["消化系统"]], ["吐黄水", ["消化系统", "急救"]],
  ["吐食物", ["消化系统"]], ["吐白沫", ["消化系统", "急救"]], ["吐了", ["消化系统", "急救"]],
  ["水样便", ["消化系统"]], ["便血", ["消化系统", "急救"]], ["大便带血", ["消化系统", "急救"]],
  ["拉不出来", ["消化系统"]], ["肚子胀", ["消化系统"]], ["放屁多", ["消化系统"]],
  ["皮肤痒", ["皮肤病"]], ["掉毛", ["皮肤病"]], ["脱毛", ["皮肤病"]],
  ["皮肤红", ["皮肤病"]], ["有皮屑", ["皮肤病"]], ["猫癣", ["皮肤病"]],
  ["身上有疙瘩", ["皮肤病"]], ["皮肤溃烂", ["皮肤病", "急救"]], ["脱毛斑秃", ["皮肤病"]],
  ["身上有红斑", ["皮肤病"]], ["皮肤结痂", ["皮肤病"]], ["长包", ["皮肤病"]],
  ["湿疹", ["皮肤病"]], ["脓皮症", ["皮肤病"]], ["真菌感染", ["皮肤病"]],
  ["耳朵臭", ["耳病"]], ["抓耳朵", ["耳病"]], ["甩头", ["耳病"]],
  ["耳螨", ["耳病"]], ["耳朵有分泌物", ["耳病"]], ["耳朵红肿", ["耳病"]],
  ["耳屎多", ["耳病"]], ["耳朵有异味", ["耳病"]],
  ["咳嗽", ["呼吸系统", "急救"]], ["打喷嚏", ["呼吸系统"]], ["流鼻涕", ["呼吸系统"]],
  ["喘", ["呼吸系统", "急救"]], ["呼吸困难", ["呼吸系统", "急救"]], ["鼻子干", ["呼吸系统"]],
  ["流鼻血", ["呼吸系统", "急救"]], ["鼻塞", ["呼吸系统"]], ["呼吸急促", ["呼吸系统", "急救"]],
  ["张嘴呼吸", ["呼吸系统", "急救"]], ["咳嗽有痰", ["呼吸系统"]], ["干咳", ["呼吸系统"]],
  ["打喷嚏流鼻涕", ["呼吸系统"]], ["喘不上气", ["呼吸系统", "急救"]],
  ["尿不出来", ["泌尿系统", "急救"]], ["尿血", ["泌尿系统", "急救"]], ["尿频", ["泌尿系统"]],
  ["乱尿", ["泌尿系统"]], ["尿多", ["泌尿系统"]], ["尿少", ["泌尿系统", "急救"]],
  ["尿黄", ["泌尿系统"]], ["尿失禁", ["泌尿系统"]], ["尿痛", ["泌尿系统"]],
  ["眼睛红", ["眼科"]], ["眼屎多", ["眼科"]], ["泪痕", ["眼科", "品种"]],
  ["眼睛肿", ["眼科", "急救"]], ["眼睛有分泌物", ["眼科"]], ["流泪", ["眼科"]],
  ["眼睛睁不开", ["眼科", "急救"]], ["第三眼睑突出", ["眼科"]],
  ["口臭", ["口腔"]], ["牙结石", ["口腔"]], ["牙龈红肿", ["口腔"]],
  ["流口水", ["口腔", "急救"]], ["牙龈出血", ["口腔"]], ["嘴巴臭", ["口腔"]],
  ["犬瘟", ["传染病", "急救"]], ["细小", ["传染病", "急救"]], ["猫瘟", ["传染病", "急救"]],
  ["犬窝咳", ["传染病"]], ["猫鼻支", ["传染病"]], ["猫杯状", ["传染病"]],
  ["狂犬病", ["传染病", "急救"]],
  ["中毒", ["中毒", "急救"]], ["吃了巧克力", ["中毒", "急救"]], ["吃了葡萄", ["中毒", "急救"]],
  ["误食", ["中毒", "急救"]], ["中暑", ["急救"]], ["被蛇咬", ["急救"]],
  ["触电", ["急救"]], ["溺水", ["急救"]], ["车祸", ["急救"]],
  ["高处坠落", ["急救"]], ["抽搐", ["急救"]], ["昏迷", ["急救"]],
  ["休克", ["急救"]], ["出血", ["急救"]],
  ["瘸了", ["骨科"]], ["腿瘸", ["骨科"]], ["跛行", ["骨科"]],
  ["不敢走路", ["骨科"]], ["腿肿", ["骨科"]], ["后腿无力", ["骨科"]],
  ["走路摇晃", ["骨科"]], ["髌骨脱位", ["骨科"]], ["髋关节", ["骨科"]],
  ["疫苗", ["疫苗"]], ["打疫苗", ["疫苗"]], ["疫苗反应", ["疫苗"]],
  ["疫苗后呕吐", ["疫苗"]], ["疫苗后没精神", ["疫苗"]], ["几周打疫苗", ["疫苗"]],
  ["疫苗多少钱", ["疫苗"]], ["疫苗过敏", ["疫苗", "急救"]],
  ["驱虫", ["驱虫"]], ["跳蚤", ["驱虫"]], ["蜱虫", ["驱虫", "急救"]],
  ["体内驱虫", ["驱虫"]], ["体外驱虫", ["驱虫"]], ["驱虫药", ["驱虫"]],
  ["便便有虫", ["驱虫"]], ["蛔虫", ["驱虫"]], ["绦虫", ["驱虫"]],
  ["拆家", ["行为"]], ["叫", ["行为"]], ["分离焦虑", ["行为"]],
  ["乱咬东西", ["行为"]], ["乱尿在床上", ["行为"]], ["护食", ["行为"]],
  ["攻击", ["行为"]], ["咬人", ["行为"]], ["胆小", ["行为"]],
  ["暴冲", ["行为"]], ["捡屎吃", ["行为"]], ["追影子", ["行为"]],
  ["比熊泪痕", ["品种", "眼科"]], ["比熊美容", ["品种"]],
  ["法斗呼吸困难", ["品种", "呼吸系统", "急救"]], ["博美气管", ["品种", "呼吸系统"]],
  ["拉布拉多关节", ["品种"]], ["折耳猫发病", ["品种"]], ["柯基掉毛", ["品种"]],
  ["金毛髋关节", ["品种"]], ["泰迪髌骨", ["品种"]], ["英短肥胖", ["品种"]],
  ["布偶猫肠胃", ["品种"]], ["德牧髋关节", ["品种"]], ["雪纳瑞皮肤", ["品种"]],
  ["比熊髌骨", ["品种"]], ["法斗皮肤病", ["品种"]], ["巴哥眼睛突出", ["品种", "急救"]],
  ["什么药能吃", ["用药安全"]], ["止痛药", ["用药安全", "急救"]],
  ["速诺", ["用药安全"]], ["大宠爱", ["驱虫", "用药安全"]],
  ["阿莫西林", ["用药安全"]], ["布洛芬", ["用药安全", "急救"]],
  ["感冒药", ["用药安全"]], ["益生菌", ["用药安全"]], ["碘伏", ["用药安全"]],
  ["双氧水", ["用药安全"]], ["眼药水", ["用药安全"]],
  ["洗澡", ["日常护理"]], ["刷牙", ["日常护理"]], ["剪指甲", ["日常护理"]],
  ["梳毛", ["日常护理"]], ["洗耳朵", ["日常护理"]],
  ["老年犬", ["老年宠物"]], ["老年猫", ["老年宠物"]], ["老狗关节", ["老年宠物"]],
  ["老猫肾衰", ["老年宠物", "急救"]],
  ["怎么办", ["通用"]], ["正常吗", ["通用"]], ["严重吗", ["通用"]],
  ["要去医院吗", ["通用"]], ["会传染人吗", ["通用"]], ["能自愈吗", ["通用"]],
  ["在家怎么处理", ["通用"]], ["多久能好", ["通用"]], ["能预防吗", ["通用"]],
  ["复发吗", ["通用"]], ["花多少钱", ["通用"]],
];

const QUESTION_FORMS = [
  "{term}怎么办", "{term}怎么回事", "{term}是什么原因",
  "{term}怎么治疗", "{term}怎么处理", "{term}正常吗",
  "{term}严重吗", "{term}吃什么药", "{term}多久能好",
  "为什么{term}", "急！{term}", "求助，{term}",
  "{term}咋回事", "{term}该咋办",
];

const SPECIES = ["我家狗", "我家猫", "毛孩子", ""];

export class QuerySimulator {
  generateSimulatedQueries(targetCount: number = 100000): SimulatedQuery[] {
    const queries: SimulatedQuery[] = [];
    let id = 0;

    for (const [term, topics] of SEED_TERMS) {
      if (queries.length >= targetCount) break;

      // 1. 直接症状词
      const difficulty: "direct" | "vague" | "implied" =
        term.length < 6 ? "direct" : "vague";

      queries.push({
        id: `sim_${id++}`,
        query: term,
        intent: `用户询问关于「${term}」的问题`,
        expectedTopics: topics,
        difficulty,
      });

      // 2. 每种问法 x 每个品种
      for (const form of QUESTION_FORMS) {
        if (queries.length >= targetCount) break;
        for (const species of SPECIES) {
          if (queries.length >= targetCount) break;
          const query = form.replace("{term}", term);
          const fullQuery = species ? `${species}${query}` : query;

          const diff: "direct" | "vague" | "implied" =
            fullQuery.length < 10 ? "direct"
            : fullQuery.includes("怎么办") || fullQuery.includes("为什么") ? "vague"
            : "implied";

          queries.push({
            id: `sim_${id++}`,
            query: fullQuery,
            intent: `用户询问关于「${term}」的问题`,
            expectedTopics: topics,
            difficulty: diff,
          });
        }
      }
    }

    return queries;
  }

  async evaluateHitRate(
    queries: SimulatedQuery[],
    batchSize: number = 1000,
    onProgress?: (progress: { done: number; total: number; hits: number }) => void,
  ): Promise<SimulationReport> {
    const searcher = new AgenticSearcher();
    let totalHits = 0;
    const byDifficulty: Record<string, { total: number; hits: number }> = {};
    const missed: Array<{ query: string; expected: string[] }> = [];

    for (let i = 0; i < queries.length; i += batchSize) {
      const batch = queries.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async (q) => {
          try {
            const plan = await searcher.search(q.query, 3);
            const hasHit = plan.steps.some((s) => s.score > 0);
            return { query: q, hasHit };
          } catch {
            return { query: q, hasHit: false };
          }
        }),
      );

      for (const result of batchResults) {
        if (result.status !== "fulfilled") continue;
        if (result.value.hasHit) totalHits++;

        const diff = result.value.query.difficulty;
        byDifficulty[diff] = byDifficulty[diff] || { total: 0, hits: 0 };
        byDifficulty[diff].total++;
        if (result.value.hasHit) byDifficulty[diff].hits++;
      }

      onProgress?.({ done: Math.min(i + batchSize, queries.length), total: queries.length, hits: totalHits });
    }

    return {
      totalGenerated: queries.length,
      totalHits,
      hitRate: queries.length > 0 ? totalHits / queries.length : 0,
      byDifficulty,
      topMissed: missed.slice(0, 50).map((m) => `${m.query} (期望: ${m.expected.join("/")})`),
      generatedAt: new Date().toISOString(),
      dataPath: "",
    };
  }
}
