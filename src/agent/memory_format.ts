import type { VectorMemoryHit } from "../memory/index.js";

type MemoryHit = VectorMemoryHit;

function clipText(text: string, maxLen: number = 120) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
}

export function formatMemorySearchResults(hits: MemoryHit[]) {
  if (!hits.length) return "没有找到相关记忆。";

  const lines: string[] = [];
  const used = new Set<string>();

  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (used.has(hit.id)) continue;

    const role = String(hit.metadata?.role || "");
    const day = hit.createdAt.slice(0, 10);
    const time = hit.createdAt.slice(11, 16);

    if (hit.kind === "message" && role === "user") {
      const reply = hits.slice(i + 1).find((candidate) =>
        !used.has(candidate.id) &&
        candidate.kind === "message" &&
        String(candidate.metadata?.role || "") === "assistant"
      );
      used.add(hit.id);
      if (reply) used.add(reply.id);

      lines.push([
        `${lines.length + 1}. [${day} ${time}]`,
        `用户问：${clipText(hit.content, 72)}`,
        reply ? `助手答：${clipText(reply.content, 96)}` : "",
      ].filter(Boolean).join("\n"));
      continue;
    }

    used.add(hit.id);
    lines.push(`${lines.length + 1}. [${day} ${time}] ${clipText(hit.content, 120)}`);
  }

  return lines.join("\n\n");
}
