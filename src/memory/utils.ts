import crypto from "crypto";
import type {
  MemoryQuery,
  MemoryRecord,
  MemoryRecordKind,
  VectorMemoryHit,
} from "./index.js";

export function nowIso() {
  return new Date().toISOString();
}

export function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function stableDigest(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function newId(kind: MemoryRecordKind) {
  return `${kind}_${crypto.randomUUID()}`;
}

export function matchesRecord(record: MemoryRecord, query: MemoryQuery) {
  if (query.namespace && record.namespace !== query.namespace) return false;
  if (query.kind && record.kind !== query.kind) return false;
  if (query.tags?.length && !query.tags.every((tag) => record.tags.includes(tag))) return false;
  if (query.text) {
    const haystack = `${record.content} ${JSON.stringify(record.metadata)}`.toLowerCase();
    if (!haystack.includes(query.text.toLowerCase())) return false;
  }
  return true;
}

export function stripInvisibleUnicode(input: string) {
  return input.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
}

export function normalizeEntry(input: string) {
  return stripInvisibleUnicode(input).trim();
}

export function tokenizeForEmbedding(input: string) {
  const normalized = stripInvisibleUnicode(input)
    .toLowerCase()
    .replace(/[`*_>#|()[\]{}]/g, " ")
    .trim();
  const wordTokens = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) || [];
  return wordTokens.filter(Boolean);
}

export function buildHashEmbedding(input: string, dimensions: number = 128) {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenizeForEmbedding(input);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const hash = stableDigest(token);
    for (let i = 0; i < 4; i += 1) {
      const offset = i * 8;
      const bucket = parseInt(hash.slice(offset, offset + 8), 16) % dimensions;
      const sign = parseInt(hash.slice(offset + 8, offset + 10), 16) % 2 === 0 ? 1 : -1;
      vector[bucket] += sign * (1 / (i + 1));
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function clipCompactText(text: string, maxLen: number = 120) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
}

export function overlapScore(text: string, query: string) {
  const textTokens = new Set(tokenizeForEmbedding(text));
  const queryTokens = tokenizeForEmbedding(query);
  if (!queryTokens.length) return 0;

  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) score += 1;
  }
  return score;
}

export function extractRelevantSnippets(content: string, query: string, limit: number = 4) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "---" && !line.startsWith("|"));

  const scored = lines
    .map((line) => ({ line, score: overlapScore(line, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = (scored.length ? scored : lines.slice(0, limit).map((line) => ({ line, score: 0 })))
    .slice(0, limit)
    .map((item) => `- ${clipCompactText(item.line, 100)}`);

  return selected.join("\n");
}

export function hasMeaningfulOverlap(content: string, query: string) {
  return overlapScore(content, query) > 0;
}

export function isLowInformationMessage(input: string) {
  const normalized = stripInvisibleUnicode(input).trim().toLowerCase();
  if (!normalized) return true;
  if (/^[a-z]{1,4}$/.test(normalized)) return true;
  if (/^[0-9]+$/.test(normalized)) return true;
  if (/^(hi|hello|hey|ok|okay|yo|test|ping|asd|aaa+|哈哈+|呵呵+|你好+|在吗|有人吗)$/i.test(normalized)) return true;
  const tokens = tokenizeForEmbedding(normalized);
  return tokens.length <= 2 && normalized.length <= 6;
}

export function isRecallHistoryQuery(input: string) {
  const normalized = stripInvisibleUnicode(input).trim().toLowerCase();
  if (!normalized) return false;
  return /昨天|昨日|之前|以前|上次|刚才|刚刚|前面|聊过|聊了什么|说过什么|提到过|记得|回忆|history|memory/i.test(normalized);
}

export function isMetaConversationTurn(userInput: string, assistantOutput: string) {
  const text = `${stripInvisibleUnicode(userInput)}\n${stripInvisibleUnicode(assistantOutput)}`.toLowerCase();
  if (/^\/[a-z]/i.test(userInput.trim())) return true;
  if (/^(hi|hello|hey|yo|你好|你好呀|在吗|哈哈哈?)$/i.test(userInput.trim())) return true;
  if (/你支持什么功能|我能帮你|我的功能|我是.*顾问|联网搜索来源|工具|model|memory|session|gateway|tui|control-ui/i.test(text)) return true;
  return false;
}

export function isNoisyMemoryHit(hit: VectorMemoryHit) {
  const content = stripInvisibleUnicode(hit.content).trim();
  if (!content) return true;
  if (/^(\*\*[^*]+：\*\*|（后续根据对话积累）|_关于当前主人的信息，会随着对话积累。_)$/.test(content)) return true;
  if (/^##?\s*昨天的对话回顾/i.test(content)) return true;
  if (/^(asd|hello|你好呀?|哈哈哈?)$/i.test(content)) return true;
  return false;
}

export function summarizeMemoryHits(hits: VectorMemoryHit[], limit: number = 4) {
  const lines: string[] = [];
  const used = new Set<string>();

  for (let i = 0; i < hits.length && lines.length < limit; i += 1) {
    const hit = hits[i];
    if (used.has(hit.id)) continue;

    const role = String(hit.metadata?.role || "");
    const when = hit.createdAt.slice(0, 16).replace("T", " ");

    if (hit.kind === "message" && role === "user") {
      const reply = hits.slice(i + 1).find((candidate) =>
        !used.has(candidate.id) &&
        candidate.kind === "message" &&
        String(candidate.metadata?.role || "") === "assistant"
      );
      used.add(hit.id);
      if (reply) used.add(reply.id);

      lines.push([
        `- [${when}] 用户：${clipCompactText(hit.content, 56)}`,
        reply ? `  助手：${clipCompactText(reply.content, 84)}` : "",
      ].filter(Boolean).join("\n"));
      continue;
    }

    used.add(hit.id);
    lines.push(`- [${when}] ${clipCompactText(hit.content, 96)}`);
  }

  return lines.join("\n");
}
