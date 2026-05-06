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
      name: "memory",
      description: "维护长期记忆。用于保存重要偏好、项目事实、经验教训；支持 add、replace、remove；没有 read。",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "remove"], description: "记忆操作" },
          target: { type: "string", enum: ["memory", "user", "domain"], description: "memory 保存长期经验；user 保存用户偏好；domain 保存领域知识/业务规则" },
          content: { type: "string", description: "add 时的新条目；remove 时也可作为 old_text；replace 时可作为 new_text" },
          old_text: { type: "string", description: "replace/remove 用的唯一子串" },
          new_text: { type: "string", description: "replace 的新条目内容" },
        },
        required: ["action"],
      },
    },
    prompt: {
      name: "memory",
      when: "用户说“记住这个”“以后都这样”“这是长期偏好/经验/领域规则”时使用",
      priority: 8,
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
      name: "pet_symptom_query",
      description: "【RAG】搜索宠物知识库（混合检索：向量+BM25+重排）。用户描述症状时优先调用，比LLM自己的知识更权威。",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "症状或问题" },
          mode: { type: "string", enum: ["qa", "search", "agentic"], description: "qa=问答(默认) search=只搜原文 agentic=可联网检索" },
        },
        required: ["query"],
      },
    },
    prompt: {
      name: "pet_symptom_query",
      when: "宠物症状、疾病、护理问题优先使用，比直接凭模型记忆回答更可靠",
      priority: 1,
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
  lines.push("1. 宠物症状/健康 -> pet_symptom_query");
  lines.push("2. 通用知识/文档 -> rag_query");
  lines.push("3. 药品 -> verify_drug");
  lines.push("4. 图片 -> analyze_pet_image");
  lines.push("5. 终端/文件 -> exec / read / write");
  lines.push("6. 记忆查询 -> memory_search");
  lines.push("7. 保存 -> memory");
  lines.push("8. 紧急症状 -> 不调工具，立即建议就医");
  lines.push("");
  lines.push("### 安全边界");
  lines.push("- 所有工具调用都会被审计记录");
  lines.push("");
  return lines;
}
