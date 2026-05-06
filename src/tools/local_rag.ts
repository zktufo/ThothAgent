/**
 * 🌐 local-rag — 本地 RAG 知识库查询工具
 *
 * 调 iMac M1 上跑着的 Python RAG 服务。
 * 混合搜索（bge-small-zh 向量 + BM25 关键词 + RRF 融合）。
 *
 * RAG 服务生命周期由 pet-agent gateway 自动管理：
 *   gateway start()  → 自动 spawn Python RAG 子进程
 *   gateway stop()   → 自动 SIGTERM 子进程
 *
 * 也可以单独启动（调试用）：
 *   cd ~/workspace-qiaobao && source venv_rag/bin/activate
 *   python3 agentic_rag_demo.py --api 0.0.0.0 8000
 *
 * 默认文档目录：~/.PetAgent/RAG（放 PDF/MD/TXT 等知识文件）
 *
 * 配置环境变量：
 *   LOCAL_RAG_URL=http://localhost:8000    # 默认自动匹配 gateway 内嵌的 RAG
 */

import { ToolResult } from "./index.js";

// ── 配置 ────────────────────────────────────────────────
// gateway 内嵌的 RAG 默认跑在 8000，也可以在环境变量里覆盖
const RAG_PORT = process.env.LOCAL_RAG_PORT || "8000";
const RAG_BASE_URL = process.env.LOCAL_RAG_URL || `http://127.0.0.1:${RAG_PORT}`;
const RAG_TIMEOUT = 30_000; // 等 LLM 推理，给足时间

// ── 类型 ────────────────────────────────────────────────
interface RagSearchDoc {
  content: string;
  source: string;
  chunk: number;
  strategy: string;
}

interface RagStatus {
  llm: string;
  embedding: string;
  docs_in_db: number;
  mode: "simple_rag" | "agentic";
  hybrid: "on" | "off";
}

// ── 底层 HTTP 调用 ────────────────────────────────────
async function ragFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${RAG_BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAG_TIMEOUT);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`RAG API ${res.status}: ${await res.text()}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── 工具 1: RAG 问答 ──────────────────────────────────

/**
 * 基于知识库回答问题。适合宠物药品、疾病、护理等领域的精确查询。
 *
 * 内部流程：向量搜索 → BM25 → RRF 融合 → 滑动展开 → LLM 生成
 *
 * @param question - 用户问题
 * @param mode     - "simple"（纯 RAG 快速）| "agentic"（智能体模式，可联网搜索）
 */
export async function ragAsk(
  question: string,
  mode: "simple" | "agentic" = "simple",
): Promise<ToolResult> {
  // 确保模式正确
  if (mode === "agentic") {
    await ragFetch(`/mode?m=on`);
  } else {
    await ragFetch(`/mode?m=off`);
  }

  try {
    const data = await ragFetch<{ answer: string }>(
      `/ask?q=${encodeURIComponent(question)}`,
    );
    return {
      success: true,
      data: data,
      message: data.answer,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      message: `RAG 查询失败: ${err.message}`,
    };
  }
}

// ── 工具 2: 知识库搜索（只搜不生成，适合预查）───────

/**
 * 搜索知识库，返回原始文档片段。适合 Agent 先查再自己回答。
 *
 * @param query - 搜索关键词
 * @param topK  - 返回条数
 */
export async function ragSearch(
  query: string,
  topK: number = 3,
): Promise<ToolResult> {
  try {
    const data = await ragFetch<{ results: RagSearchDoc[] }>(
      `/search?q=${encodeURIComponent(query)}&k=${topK}`,
    );

    if (!data.results?.length) {
      return {
        success: true,
        data: [],
        message: "知识库中没有找到相关信息。",
      };
    }

    const docs = data.results.map(
      (d, i) =>
        `[${i + 1}] 来自「${d.source}」(chunk ${d.chunk + 1}, ${d.strategy}):\n${d.content}`,
    );

    return {
      success: true,
      data: data.results,
      message: docs.join("\n\n"),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      message: `知识库搜索失败: ${err.message}`,
    };
  }
}

// ── 工具 3: 知识库状态 ────────────────────────────────

/**
 * 查看 RAG 服务状态：文档数、当前模式、检索方式等。
 */
export async function ragStatus(): Promise<ToolResult> {
  try {
    const status = await ragFetch<RagStatus>("/status");
    return {
      success: true,
      data: status,
      message: [
        `📚 知识库: ${status.docs_in_db} 条记录`,
        `🧠 模式: ${status.mode === "agentic" ? "Agentic RAG" : "纯 RAG"}`,
        `🔍 检索: ${status.hybrid === "on" ? "混合搜索(向量+BM25)" : "纯向量"}`,
        `🤖 LLM: ${status.llm}`,
        `📐 Embedding: ${status.embedding}`,
      ].join("\n"),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      message: `RAG 服务未启动或无法访问（${RAG_BASE_URL}）`,
    };
  }
}

// ── 工具 4: 知识库重导 ────────────────────────────────

/**
 * 强制重建知识库索引。新增/修改文档后调用。
 */
export async function ragReindex(): Promise<ToolResult> {
  try {
    const data = await ragFetch<{ status: string; stats: any }>("/reindex");
    return {
      success: true,
      data: data.stats,
      message: `✅ 知识库重建完成，共 ${data.stats.total_in_db} 条记录`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      message: `重建失败: ${err.message}`,
    };
  }
}

// ── 使用示例 ───────────────────────────────────────────

/**
 * 在 Agent 中的使用方式：
 *
 * ```typescript
 * import { ragAsk, ragSearch, ragStatus } from "../tools/local_rag.js";
 *
 * // 场景 1: 快速问答
 * const answer = await ragAsk("狗狗呕吐怎么办");
 * if (answer.success) {
 *   console.log(answer.message);
 * }
 *
 * // 场景 2: 先查后决定
 * const docs = await ragSearch("泰迪 皮肤病");
 * if (docs.success) {
 *   // docs.data 是结构化结果，可以自己加工
 *   // docs.message 是格式化后的文本供 LLM 使用
 * }
 *
 * // 场景 3: 检查服务状态
 * const status = await ragStatus();
 * ```
 */
