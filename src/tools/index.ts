/**
 * Built-in tools for pet-agent.
 */
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  message: string;
}

// ── Drug database ────────────────────────────────────────────────────────────
const PET_DRUGS: Record<string, any> = {
  "6902011001": {
    name: "拜耳内虫清 (Bayer Drontal Plus)",
    generic: "吡喹酮 + 双羟萘酸噻嘧啶",
    manufacturer: "德国拜耳动物保健",
    type: "驱虫药",
    description: "用于治疗犬猫蛔虫、钩虫、绦虫等肠道寄生虫",
  },
  "6902011002": {
    name: "辉瑞妙三多 (Pfizer Primucell)",
    generic: "猫杯状病毒疫苗株",
    manufacturer: "辉瑞动物保健品",
    type: "疫苗",
    description: "猫三联疫苗，预防猫瘟、猫杯状病毒病、猫鼻气管炎",
  },
  "6902011003": {
    name: "硕腾卫佳五 (Zoetis Vanguard Plus 5)",
    generic: "犬瘟热、犬腺病毒、犬细小病毒等",
    manufacturer: "硕腾(上海)动物保健品",
    type: "疫苗",
    description: "犬五联疫苗，预防犬瘟热、犬腺病毒、犬细小病毒等",
  },
  "6902011004": {
    name: "耳康滴耳液",
    generic: "硫酸新霉素 + 氢化可的松",
    manufacturer: "上海信元动物药品",
    type: "抗生素",
    description: "用于治疗犬猫耳道感染、外耳炎",
  },
  "6902011005": {
    name: "爱沃克滴剂 (Elanco Advantage Multi)",
    generic: "莫西克丁 + 吡咯尼群",
    manufacturer: "爱沃克动物保健",
    type: "驱虫药",
    description: "犬猫外用驱虫滴剂，预防心丝虫、跳蚤、耳螨等",
  },
  "6902011006": {
    name: "贝卫多 (Boehringer NexGard)",
    generic: "阿福拉纳",
    manufacturer: "勃林格殷格翰动物保健",
    type: "驱虫药",
    description: "犬用口服驱虫咀嚼片，预防跳蚤、蜱虫",
  },
  "6902011007": {
    name: "速诺 (Zoetis Clavamox)",
    generic: "阿莫西林克拉维酸钾",
    manufacturer: "硕腾动物保健",
    type: "抗生素",
    description: "广谱抗生素，用于宠物皮肤、呼吸道、泌尿道感染",
  },
  "6902011008": {
    name: "美昔 (Meloxicam)",
    generic: "美洛昔康",
    manufacturer: "南京金盾动物药品",
    type: "止痛药",
    description: "非甾体抗炎药，用于宠物止痛、退烧、关节炎",
  },
};

export function verifyDrug(barcode?: string, nameHint?: string): ToolResult {
  if (barcode) {
    const drug = PET_DRUGS[barcode];
    if (drug) {
      return {
        success: true,
        data: drug,
        message: `✅ 验证通过！找到药品：${drug.name}\n\n厂商：${drug.manufacturer}\n类型：${drug.type}\n说明：${drug.description}`,
      };
    } else {
      return {
        success: false,
        error: "条码不在数据库中",
        message: `⚠️ 警告：该条码 ${barcode} 不在数据库中。可能为假药、未经注册的药品，或使用了特殊条码。请谨慎使用，建议通过正规渠道购买。`,
      };
    }
  }

  if (nameHint) {
    const hits = Object.values(PET_DRUGS).filter((d: any) =>
      nameHint.includes(d.name) ||
      d.name.includes(nameHint) ||
      d.type.includes(nameHint)
    );

    if (hits.length === 1) {
      const drug = hits[0];
      return {
        success: true,
        data: drug,
        message: `🔍 根据「${nameHint}」找到：${drug.name}（${drug.generic}），厂商：${drug.manufacturer}`,
      };
    } else if (hits.length > 1) {
      return {
        success: true,
        data: hits,
        message: `🔍 根据「${nameHint}」找到 ${hits.length} 种药品，请提供更具体信息`,
      };
    }
  }

  return {
    success: false,
    error: "缺少参数",
    message: "❓ 请提供药品条码或名称以供验证",
  };
}
