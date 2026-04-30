/**
 * Domain synonym lexicon for local semantic retrieval.
 *
 * Keep this table small, explicit, and easy to edit.
 * Retrieval logic consumes it as a light-weight semantic expansion layer
 * before/alongside embedding scoring.
 */
export const SEMANTIC_ALIAS_MAP: Record<string, string[]> = {
  "食欲下降": ["appetite_low", "不爱吃饭", "没胃口", "厌食"],
  "不爱吃饭": ["appetite_low", "食欲下降", "没胃口", "厌食"],
  "没胃口": ["appetite_low", "食欲下降", "不爱吃饭", "厌食"],
  "厌食": ["appetite_low", "食欲下降", "不爱吃饭", "没胃口"],
  "挑食": ["appetite_issue", "不爱吃饭", "食欲下降"],
  "呕吐": ["vomit", "吐了", "吐", "反胃"],
  "吐了": ["vomit", "呕吐", "吐", "反胃"],
  "腹泻": ["diarrhea", "拉稀", "软便"],
  "拉稀": ["diarrhea", "腹泻", "软便"],
  "软便": ["diarrhea", "腹泻", "拉稀"],
  "换粮": ["diet_change", "新粮", "换狗粮", "换猫粮"],
  "新粮": ["diet_change", "换粮"],
  "肠胃应激": ["gi_stress", "肠胃不适", "胃肠刺激"],
  "肠胃不适": ["gi_stress", "肠胃应激", "胃肠刺激"],
  "绝育": ["surgery", "手术"],
  "手术": ["surgery", "绝育"],
  "狗狗": ["犬", "狗子"],
  "猫咪": ["猫猫", "猫"],
};

export function resolveSemanticAliases(token: string) {
  return SEMANTIC_ALIAS_MAP[token] || [];
}
