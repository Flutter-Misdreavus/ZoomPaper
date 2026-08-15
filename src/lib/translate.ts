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

/**
 * 按空行把 markdown 切成非空「块」（段落/标题/列表/代码块/公式块/图片行等），供对照模式逐段配对。
 * 与 `chunkMarkdown` 一样不切分围栏代码块（```…```）与行内数学块（$$…$$）内部。
 */
export function splitBlocks(md: string): string[] {
  const lines = md.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;

  const push = () => {
    // 去掉块首/块尾空行
    while (cur.length > 0 && cur[0].trim() === "") cur.shift();
    while (cur.length > 0 && cur[cur.length - 1].trim() === "") cur.pop();
    if (cur.length > 0) {
      blocks.push(cur.join("\n"));
    }
    cur = [];
  };

  for (const line of lines) {
    const t = line.trim();
    // 围栏块内原样收下
    if (fence) {
      cur.push(line);
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    // 进入围栏块
    if (t.startsWith("```") || t.startsWith("$$")) {
      fence = t.startsWith("```") ? "```" : "$$";
      cur.push(line);
      continue;
    }
    // 空行 = 段落边界，总是断块
    if (t === "") {
      push();
      continue;
    }
    cur.push(line);
  }
  push();
  return blocks;
}

/** 对照配对：把英文原文与中文全文各自按段落切分后按序配对（取较短一侧）。 */
export function pairBlocks(enMd: string, zhDoc: string): {
  pairs: { en: string; zh: string }[];
  enCount: number;
  zhCount: number;
  /** 未配对的英文段（中文段不足时剩余） */
  restEn: string[];
} {
  const en = splitBlocks(enMd);
  const zh = splitBlocks(zhDoc);
  const n = Math.min(en.length, zh.length);
  return {
    pairs: en.slice(0, n).map((e, i) => ({ en: e, zh: zh[i] })),
    enCount: en.length,
    zhCount: zh.length,
    restEn: en.slice(n),
  };
}

/**
 * 去掉「单独成行」的图片引用与整块公式（仅对照模式中文段用），保留行内公式。
 * - 整块公式 `$$...$$` → 删除；
 * - 单独成行的图片 `![](...)` → 删除该行；
 * - 行内公式 `$...$` 与行内嵌图 → 保留；
 * - 围栏代码块/行内代码内的内容不受影响。
 */
export function stripStandaloneImagesAndMath(md: string): string {
  if (!md) return "";
  const code: string[] = [];
  let guarded = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  // 去掉整块公式（$$...$$）
  guarded = guarded.replace(/\$\$[\s\S]*?\$\$/g, "");
  // 去掉单独成行的图片引用
  guarded = guarded
    .split("\n")
    .map((line) => (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line) ? "" : line))
    .join("\n");
  // 折叠多余空行
  guarded = guarded.replace(/\n{3,}/g, "\n\n");
  return guarded.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}
