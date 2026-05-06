import type { LLMToolDefinition } from "../llm/index.js";

export interface BuiltinToolPromptSpec {
  name: string;
  when: string;
  priority?: number;
  safety?: string[];
}

export interface BuiltinToolSpec {
  definition: LLMToolDefinition;
  prompt: BuiltinToolPromptSpec;
}

export const BUILTIN_TOOL_SPECS: BuiltinToolSpec[] = [
  {
    definition: {
      name: "agent_manage",
      description: "管理多 agent。可创建新 agent、查看已有 agent 列表。适合用户明确提出“新建一个负责某领域/某任务的 agent”时使用。",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "list"], description: "create 创建新 agent；list 列出已有 agent" },
          agent_id: { type: "string", description: "新 agent 的唯一标识，建议使用英文短横线命名；未提供时会基于 display_name 生成" },
          display_name: { type: "string", description: "用户可见名称，例如 Research Agent" },
          description: { type: "string", description: "该 agent 的职责、领域范围或行为说明" },
          primary_model: { type: "string", description: "可选：为新 agent 指定主模型路由，如 openai/gpt-4o-mini" },
          fallback_models: {
            type: "array",
            items: { type: "string" },
            description: "可选：为新 agent 指定 fallback 模型路由列表",
          },
        },
        required: ["action"],
      },
    },
    prompt: {
      name: "agent_manage",
      when: "用户明确要求创建新 agent、拆分子角色、为特定领域建立独立 agent 时使用",
      priority: 6,
    },
  },
  {
    definition: {
      name: "memory",
      description: "维护内置长期记忆文件。用于把稳定、高价值、可复用的信息写入 USER.md、MEMORY.md 或 DOMAIN.md；支持 add、replace、remove；不要用它保存一次性上下文。",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "replace", "remove"],
            description: "必填。add=新增一条长期记忆；replace=把已有旧内容替换成更准确的新内容；remove=删除过时/错误/冲突的旧内容",
          },
          target: {
            type: "string",
            enum: ["memory", "user", "domain"],
            description: "必填。user -> USER.md，保存用户称呼、偏好、风格、长期习惯；memory -> MEMORY.md，保存项目事实、长期经验、稳定约定；domain -> DOMAIN.md，保存领域规则、术语、流程边界、业务知识",
          },
          content: {
            type: "string",
            description: "推荐在 add 时使用。写入的内容应是去歧义、可复用、单条即可理解的完整记忆，例如“用户偏好：回答先给结论再列风险”。",
          },
          old_text: {
            type: "string",
            description: "replace/remove 时必填。必须是目标文件里已经存在、且足够唯一的一段旧文本，用于精确定位要替换或删除的内容。",
          },
          new_text: {
            type: "string",
            description: "replace 时必填。用于替换 old_text 的新内容。应包含纠正后的完整表述，而不是只写差异片段。",
          },
          reason: {
            type: "string",
            description: "可选。说明为什么要写这条记忆，例如“用户明确说以后都这样回答”“这是稳定的业务规则”。仅用于帮助推理，不直接写入文件。",
          },
        },
        required: ["action", "target"],
      },
    },
    prompt: {
      name: "memory",
      when: "用户明确要求记住，或你识别出稳定的长期偏好、项目约定、经验结论、领域规则时使用；不要用于临时寒暄和一次性上下文",
      priority: 8,
      safety: [
        "不要保存一次性上下文、临时问题编号、当前轮即时情绪、低信息量寒暄",
        "写入前先判断归属：用户偏好 -> user；长期项目/经验 -> memory；领域规则/术语/流程 -> domain",
        "replace/remove 必须提供唯一 old_text，避免误删无关内容",
      ],
    },
  },
  {
    definition: {
      name: "memory_search",
      description: "搜索用户专属记忆库。适合回答昨天聊了什么、之前提到过什么、上次说到哪里等问题。",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "要回忆的主题、关键词或自然语言问题" },
          limit: { type: "number", description: "返回的最多条数，默认 8" },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["message", "fact", "summary", "preference", "event", "best_try"] },
            description: "可选：限制记忆类型",
          },
        },
        required: ["query"],
      },
    },
    prompt: {
      name: "memory_search",
      when: "用户问“昨天聊了什么”“记得吗”“之前提到过吗”这类跨会话回忆问题时优先使用",
      priority: 7,
    },
  },
  {
    definition: {
      name: "tool_stats",
      description: "统计当前 session 的工具调用成功率、失败率、各工具调用次数和最近失败原因。用户询问 tool 调用成功率、工具质量、最近工具失败时优先使用。",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "最近失败样本数量，默认 5" },
        },
      },
    },
    prompt: {
      name: "tool_stats",
      when: "用户询问工具调用成功率、失败率、最近 tool 是否稳定、哪些工具失败最多时使用",
      priority: 7,
    },
  },
  {
    definition: {
      name: "session_search",
      description: "搜索 session 历史，用于回忆过去讨论过但未写入长期记忆的内容。",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的历史对话关键词或问题" },
          limit: { type: "number", description: "最多返回多少条历史片段，默认 8" },
        },
        required: ["query"],
      },
    },
    prompt: {
      name: "session_search",
      when: "当 memory_search 不足以回答，且需要补充检索原始历史对话时使用",
    },
  },
  {
    definition: {
      name: "verify_drug",
      description: "校验宠物药品条码、名称和基础安全提醒",
      input_schema: {
        type: "object",
        properties: {
          barcode: { type: "string", description: "药品条码，通常为 10 位及以上数字" },
          name_hint: { type: "string", description: "药品名称、描述或用户原话" },
        },
      },
    },
    prompt: {
      name: "verify_drug",
      when: "用户提到药品名称、条码、批次、真假验证时使用",
      priority: 3,
    },
  },
  {
    definition: {
      name: "analyze_pet_image",
      description: "分析宠物照片中的健康线索",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "希望模型重点关注的图片分析要求" },
          image_path: { type: "string", description: "图片路径；默认使用当前用户上传的图片" },
        },
      },
    },
    prompt: {
      name: "analyze_pet_image",
      when: "用户发送了宠物照片或视频截图，希望分析可见健康线索时使用",
      priority: 4,
    },
  },

  {
    definition: {
      name: "rag_query",
      description: "【RAG】通用知识库查询。任何领域知识问题都可使用，外挂本地知识库。",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "要查询的问题" },
          mode: { type: "string", enum: ["qa", "search", "agentic"], description: "qa=问答(默认) search=只搜原文 agentic=可联网检索" },
          topK: { type: "number", description: "返回条数（仅search模式）" },
        },
        required: ["query"],
      },
    },
    prompt: {
      name: "rag_query",
      when: "非宠物垂直问题、技术文档、自定义知识库查询时使用",
      priority: 2,
    },
  },
  {
    definition: {
      name: "exec",
      description: "在安全沙箱中执行 shell 命令。支持文件操作、git、npm 等。",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
        },
        required: ["command"],
      },
    },
    prompt: {
      name: "exec",
      when: "需要运行脚本、git、npm、系统命令或批量文件操作时使用",
      safety: ["exec 在沙箱中执行：禁止 rm -rf / sudo / eval / 系统写操作"],
    },
  },
  {
    definition: {
      name: "read",
      description: "在安全沙箱中读取文件内容。仅支持文本文件（.ts, .js, .json, .md, .txt 等）。",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要读取的文件路径" },
          offset: { type: "number", description: "起始行号（从1开始，可选）" },
          limit: { type: "number", description: "最多读取的行数（可选）" },
        },
        required: ["file_path"],
      },
    },
    prompt: {
      name: "read",
      when: "查看项目文件、代码、配置、日志内容时使用",
      safety: ["read/write 仅限项目目录 / ~/clawd / /tmp 内"],
    },
  },
  {
    definition: {
      name: "write",
      description: "在安全沙箱中写入文件内容。自动创建父目录。支持覆盖和追加模式。",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "写入的文件路径" },
          content: { type: "string", description: "文件内容" },
          append: { type: "boolean", description: "是否追加到文件末尾（而不是覆盖），默认 false" },
        },
        required: ["file_path", "content"],
      },
    },
    prompt: {
      name: "write",
      when: "修改配置、写入日志、生成代码或文本文件时使用",
      safety: ["read/write 仅限项目目录 / ~/clawd / /tmp 内"],
    },
  },
];

export function buildBuiltinLLMToolDefinitions(options: { imagePath?: string } = {}): LLMToolDefinition[] {
  return BUILTIN_TOOL_SPECS
    .filter((spec) => options.imagePath || spec.definition.name !== "analyze_pet_image")
    .map((spec) => spec.definition);
}

export function buildBuiltinToolDirectoryLines(): string[] {
  const lines: string[] = [
    "===== 工具 (Tools) =====",
    "以下工具通过统一注册表生成，并通过 API 原生函数调用提供；LLM 应在可用时直接调用。",
    "",
  ];

  for (const spec of BUILTIN_TOOL_SPECS) {
    lines.push(`- name: ${spec.prompt.name}`);
    lines.push(`  desc: ${spec.definition.description}`);
    lines.push(`  when: ${spec.prompt.when}`);
    if (typeof spec.prompt.priority === "number") {
      lines.push(`  priority: ${spec.prompt.priority}`);
    }
    if (spec.prompt.safety?.length) {
      lines.push(`  safety: ${spec.prompt.safety.join("；")}`);
    }
    lines.push("");
  }

  lines.push("### 优先级规则");
  lines.push("1. 通用知识/文档/RAG -> rag_query");
  lines.push("2. 药品 -> verify_drug");
  lines.push("3. 图片 -> analyze_pet_image");
  lines.push("4. 终端/文件 -> exec / read / write");
  lines.push("5. 多 agent 管理 -> agent_manage");
  lines.push("6. 记忆查询 -> memory_search");
  lines.push("7. 工具统计 -> tool_stats");
  lines.push("8. 保存 -> memory");
  lines.push("9. 紧急症状 -> 不调工具，立即建议就医");
  lines.push("");
  return lines;
}
