import { initPetRag } from "./orchestrator.js";
import { SourceLoader } from "./loaders/source_loader.js";
import { tokenizeForEmbedding } from "../memory/utils.js";
import type { RagChunk } from "./types.js";

export interface CleanIssue {
  chunkId: string;
  type: "empty" | "too_short" | "duplicate" | "no_source" | "noise" | "conflict";
  severity: "error" | "warn" | "info";
  description: string;
}

export interface CleanReport {
  totalChunks: number;
  issues: CleanIssue[];
  actionable: number;
  cleanPercent: number;
}

const MIN_CHUNK_LENGTH = 20;
const NOISE_PATTERNS = [
  /^[\s\-—*_.,;:!?~·•●○■□◆◇]+$/,
  /^[a-zA-Z0-9]{100,}$/,
  /^(www\.|http)/i,
  /^[0-9.\-]+$/,
];

export class DataCleaner {
  cleanSourceDocs(): CleanReport {
    const issues: CleanIssue[] = [];
    const loader = new SourceLoader();
    const docs = loader.embeddedDocs();
    let totalChunks = 0;

    for (const doc of docs) {
      const sections = doc.content.split(/\n#{2,3}\s+/);
      for (let i = 0; i < sections.length; i++) {
        totalChunks++;
        const section = sections[i].trim();
        const chunkId = `${doc.id}#section-${i}`;

        if (!section || section.length < 5) {
          issues.push({ chunkId, type: "empty", severity: "error", description: `空块：${doc.id}` });
          continue;
        }

        if (section.length < MIN_CHUNK_LENGTH) {
          issues.push({ chunkId, type: "too_short", severity: "warn", description: `片段过短（${section.length} chars）` });
        }

        for (const pattern of NOISE_PATTERNS) {
          if (pattern.test(section)) {
            issues.push({ chunkId, type: "noise", severity: "warn", description: `无意义内容` });
            break;
          }
        }

        if (!section.includes("来源：") && !section.includes("source:") && !section.includes("参考")) {
          issues.push({ chunkId, type: "no_source", severity: "info", description: `缺少来源标注` });
        }
      }
    }

    // Duplicate detection
    const texts: Array<{ id: string; text: string; tokens: string[] }> = [];
    for (const doc of docs) {
      const sections = doc.content.split(/\n#{2,3}\s+/);
      sections.forEach((s: string, i: number) => {
        if (s.trim().length > MIN_CHUNK_LENGTH) {
          texts.push({ id: `${doc.id}#section-${i}`, text: s.trim(), tokens: tokenizeForEmbedding(s) });
        }
      });
    }

    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const overlap = texts[i].tokens.filter((t) => texts[j].tokens.includes(t)).length;
        const ratio = Math.max(texts[i].tokens.length, texts[j].tokens.length);
        if (ratio > 0 && overlap / ratio > 0.7) {
          issues.push({
            chunkId: `${texts[i].id} ↔ ${texts[j].id}`,
            type: "duplicate",
            severity: "warn",
            description: `近似重复（${(overlap / ratio * 100).toFixed(0)}%）`,
          });
        }
      }
    }

    const actionable = issues.filter((i) => i.severity !== "info").length;
    return { totalChunks, issues, actionable, cleanPercent: totalChunks > 0 ? ((totalChunks - actionable) / totalChunks) * 100 : 100 };
  }
}
