# Skills Directory

这个目录和 `src/` 同级，风格上更接近 OpenClaw。

可以在这里放两类技能定义：

1. 目录技能
   例如：`skills/my-skill/SKILL.md`

2. JSON 清单技能
   例如：`skills/skill_my_skill.json`

当前项目的 `SkillRegistry` 会优先扫描这个目录，再补充内置技能。
