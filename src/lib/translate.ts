import type { TranslationChunk } from "@/lib/api";

/**
 * 把英文 Markdown 全文切成「结构感知」的翻译块：
 * - 围栏代码块（```…```）与行内数学块（$$…$$）内部不切分；
 * - 优先在空行（段落边界）处断块，且尽量让标题行（`^#{1,6} `）作为块首；
 * - 单段超长时按行硬断兜底，避免单个块超出 LLM 输出上限。
 */
export function chunkMarkdown(md: string, maxChars = 2500): string[] {
  const lines = md.split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let fence: string | null = null; // 当前所在的 ``` 或 $$ 块标记

  const push = () => {
    // 去掉块首/块尾的空行，避免拼接时出现多余空段
    while (cur.length > 0 && cur[0].trim() === "") cur.shift();
    while (cur.length > 0 && cur[cur.length - 1].trim() === "") cur.pop();
    if (cur.length > 0) {
      chunks.push(cur.join("\n"));
    }
    cur = [];
    curLen = 0;
  };

  for (const line of lines) {
    const t = line.trim();
    // 在围栏块内：原样收下，直到遇到闭合标记
    if (fence) {
      cur.push(line);
      curLen += line.length + 1;
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    // 进入围栏块
    if (t.startsWith("```") || t.startsWith("$$")) {
      fence = t.startsWith("```") ? "```" : "$$";
      cur.push(line);
      curLen += line.length + 1;
      continue;
    }
    // 标题行：已有内容且超过阈值时，块首落在此标题前
    const isHeading = /^#{1,6}\s/.test(t);
    if (isHeading && cur.length > 0 && curLen >= maxChars) {
      push();
    }
    // 空行即段落边界，超过阈值就断块
    const isBlank = t === "";
    cur.push(line);
    curLen += line.length + 1;
    if (isBlank && curLen >= maxChars) {
      push();
    } else if (curLen >= maxChars * 2) {
      // 兜底：超长段落按行硬断
      push();
    }
  }
  push();
  return chunks;
}

/** 纯中文文档：把各块中文译文按段落拼接。 */
export function buildZhDoc(chunks: TranslationChunk[]): string {
  return chunks.map((c) => c.zh).join("\n\n");
}

/** 对照文档：按「英文块 → 中文块」交错拼接，`---` 作中英分隔线。 */
export function buildBiDoc(chunks: TranslationChunk[]): string {
  return chunks.flatMap((c) => [c.en, c.zh]).join("\n\n---\n\n");
}
