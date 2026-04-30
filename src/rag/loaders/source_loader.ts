/**
 * Markdown/Source 文档加载器
 *
 * 支持加载本地 .md 文件、.json 结构数据。
 * 接口统一，后续可扩展 PDF/HTML 加载器。
 */
import fs from "fs";
import path from "path";
import type { RagDocument, RagImportOptions } from "../types.js";

export interface SourceLoaderOptions {
  /** 知识库根目录，默认 rag/data/knowledge */
  knowledgeDir?: string;
}

export class SourceLoader {
  readonly knowledgeDir: string;

  constructor(options: SourceLoaderOptions = {}) {
    this.knowledgeDir = options.knowledgeDir || path.resolve(
      process.cwd().replace(/\/dist$/, ""), "rag", "data", "knowledge"
    );
  }

  async loadAll(onProgress?: (msg: string) => void): Promise<RagDocument[]> {
    const docs: RagDocument[] = [];

    // 加载 data/knowledge/ 下所有 .md 文件
    if (fs.existsSync(this.knowledgeDir)) {
      const entries = fs.readdirSync(this.knowledgeDir, { withFileTypes: true });
      for (const entry of entries) {
        const filePath = path.join(this.knowledgeDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const doc = this.loadMarkdownFile(filePath);
          docs.push(doc);
          onProgress?.(`📄 ${entry.name}`);
        }
      }
    }

    if (docs.length === 0) {
      // 没有任何源文档时用内嵌知识
      onProgress?.("(使用内嵌知识库)");
      docs.push(...this.embeddedDocs());
    }

    return docs;
  }

  private loadMarkdownFile(filePath: string): RagDocument {
    const content = fs.readFileSync(filePath, "utf-8");
    const fileName = path.basename(filePath, ".md");
    const lines = content.split("\n").filter((l) => l.trim());
    const title = lines[0]?.replace(/^#\s*/, "").trim() || fileName;
    
    return {
      id: `doc_${fileName}`,
      source: "markdown",
      title,
      content,
      metadata: { filePath, fileName },
      importedAt: new Date().toISOString(),
    };
  }

  /** 内置知识库（当 data/knowledge/ 为空时的 fallback） */
    embeddedDocs(): RagDocument[] {
    const E = (id: string, title: string, content: string): RagDocument => ({
      id, source: "structured" as const, title, content,
      metadata: { builtin: true },
      importedAt: new Date().toISOString(),
    });

    return [
      E("emergency", "宠物急救流程",
`# 宠物急救流程

## 🚨 快速判断是否需要立即就医
以下情况属于急症，需要立即送医：
1. 呼吸困难、张口呼吸、舌头发紫
2. 严重出血（按压5分钟不止血）
3. 抽搐/癫痫发作持续超过2分钟
4. 被车撞或高处坠落
5. 误食有毒物质（巧克力、葡萄、木糖醇、百合花）
6. 公猫超过24小时完全尿不出
7. 中暑（体温超过40℃、呼吸急促、流涎）
8. 眼睛突出或眼外伤
9. 意识丧失
10. 严重呕吐或腹泻超过24小时

## 🆘 送医前准备
1. 保持宠物安静，减少移动
2. 收集可疑毒物样本或包装
3. 记录发病时间和症状变化
4. 提前电话联系医院说明情况
5. 准备好宠物的疫苗记录和病史
`),

      E("symptoms-general", "宠物常见症状判断",
`# 宠物常见症状判断

## 消化系统
- **呕吐**：禁食4-6小时观察，超24小时或带血就医
- **腹泻**：禁食12小时、补清水，超48小时就医
- **便秘**：增加水分和纤维，超72小时就医
- **食欲下降**：持续超过24小时需就医

## 皮肤系统
- **瘙痒/抓挠**：检查跳蚤，保持清洁，超1周就医
- **脱毛**：猫癣可能性大，伍德灯检查
- **耳道异味**：耳螨或细菌感染，需耳镜检查

## 呼吸系统
- **咳嗽**：区分干咳/湿咳，小型犬注意气管塌陷
- **打喷嚏/流鼻涕**：清亮=过敏/初期，黄绿色脓性=细菌感染

## 泌尿系统
- **尿频/血尿**：收集新鲜尿液样本就医
- **尿不出**：公猫完全尿闭24小时以上致死，立即就医

## 眼睛
- **红肿/分泌物增多**：生理盐水冲洗，猫鼻支需抗病毒治疗

## 口腔
- **口臭/牙结石**：需麻醉洗牙，日常刷牙预防
`),

      E("drug-safety", "宠物用药安全红线",
`# 宠物用药安全红线

## ❌ 人类药物绝对禁止
- 人类止痛药（布洛芬、对乙酰氨基酚）→ 猫狗致死
- 人类止泻药 → 掩盖病情
- 人类皮炎平（含类固醇）→ 加重感染
- 人类眼药水（含类固醇）→ 加重疱疹病毒
- 阿司匹林 → 猫极敏感，可致死
- 云南白药等止血粉 → 影响伤口的判断

## ✅ 可用的人类药物（仅限应急，建议就医）
- 3%双氧水 → 催吐（仅误食2小时内，意识清醒时）
- 生理盐水 → 冲洗伤口/眼睛

## ⚠️ 常见禁用搭配
= 猫 + 任何含对乙酰氨基酚的药物 = 致命
= 狗 + 巧克力（黑巧20g/kg可致死）
= 猫 + 百合花（任何部分，包括花粉）
= 狗/猫 + 葡萄/葡萄干（可引起肾衰竭）
= 狗/猫 + 木糖醇（0.1g/kg可致低血糖）
= 猫 + 菊酯类驱虫药（犬用蚤不到对猫剧毒）

## 💊 宠物常用安全药
| 药品 | 用途 | 注意事项 |
|------|------|----------|
| 速诺(Clavamox) | 广谱抗生素 | 需按体重给药 |
| 美昔(Meloxicam) | NSAIDs止痛 | 猫慎用，需监测肾功 |
| 大宠爱(Revolution) | 内外同驱 | 猫狗剂量不同 |
| 耳康 | 耳道感染 | 先用洗耳液清洁 |
| 爱沃克(Advantage Multi) | 内外同驱 | 猫用/犬用不可混 |
`),

      E("vaccination", "宠物疫苗接种指南",
`# 宠物疫苗接种指南

## 犬核心疫苗（必须打）
- 犬瘟热病毒(CDV)
- 犬细小病毒(CPV-2)
- 犬腺病毒(CAV-2)

## 猫核心疫苗（必须打）
- 猫泛白细胞减少症(FPV) - 猫瘟
- 猫疱疹病毒(FHV-1) - 猫鼻支
- 猫杯状病毒(FCV)

## 接种时间表
- 幼犬/幼猫6-8周 → 第一针
- 10-12周 → 第二针（加强）
- 14-16周 → 第三针（加强）
- 1年后 → 加强
- 之后每3年 → 加强（核心疫苗）

## 注意事项
- 疫苗后轻微嗜睡/食欲下降属正常，24-48小时恢复
- 严重过敏反应（面部肿胀、呼吸困难）极罕见但需立即就医
- 接种前需驱虫
- 怀孕或生病时不可接种
`),

      E("breeds-guide", "宠物品种特殊注意事项",
`# 宠物品种特殊注意事项

## 犬种

### 比熊犬
- **泪痕**：常见问题，清淡低盐饮食+每日清洁
- **皮肤敏感**：易过敏，注意饮食和环境
- **髌骨脱位**：避免跳跃，控制体重
- **白内障**：老年常见，定期检查
- **美容**：每1-2个月修剪，每日梳毛防打结
- **对某些抗生素敏感**（如磺胺类）

### 拉布拉多/金毛
- **髋关节发育不良(CHD)**：幼犬期避免过度运动
- **肥胖**：天生贪吃，严格控制食量
- **外耳炎**：垂耳易发，定期检查和清洁
- **运动需求大**：每日至少1小时运动

### 法斗/英斗/巴哥（扁脸品种）
- **呼吸问题(BOAS)**：避免剧烈运动，保持凉爽
- **易中暑**：夏天特别注意
- **皮肤褶皱炎**：每日清洁并保持干燥
- **麻醉风险高**：手术前需评估
- **飞机托运有风险**：部分航司禁运

### 博美/吉娃娃（小型犬）
- **气管塌陷**：用胸背带代替项圈
- **髌骨脱位**：避免从高处跳下
- **牙齿问题**：乳牙滞留需拔除

## 猫种

### 布偶猫
- **肠胃敏感**：饮食变化需逐步过渡
- **长毛需每日梳理**：防止毛球
- **温和性格**：适合家庭，但需陪伴

### 波斯猫/异短（扁脸猫）
- **眼部问题**：泪管易阻塞，每日清洁
- **呼吸道**：短鼻综合征
- **面部褶皱**：每日清洁保持干燥

### 折耳猫
- **软骨发育不良**：所有折耳猫均有此遗传病
- **关节疼痛**：需止痛管理，不要繁育
`),
    ];
  }
}
