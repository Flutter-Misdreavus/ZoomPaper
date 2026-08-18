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

/** 对照配对结果（单个翻译块或全局） */
export interface PairResult {
  pairs: { en: string; zh: string }[];
  /** 未配对的英文段（无对应中文译文） */
  restEn: string[];
  /** 未配对的中文段（多余译文） */
  restZh: string[];
}

/** 块类型：配对打分时优先同类相配（标题由标题锚定单独处理） */
type BlockKind =
  | "heading"
  | "code"
  | "math"
  | "image"
  | "table"
  | "list"
  | "quote"
  | "para";

/** 块签名：类型 + 翻译须原样保留的锚点 token + 长度（供配对打分） */
interface BlockSig {
  kind: BlockKind;
  anchors: string[];
  len: number;
}

const normToken = (s: string) => s.replace(/\s+/g, " ").trim();

/** 提取翻译必须原样保留的锚点 token：行内公式 / 行内代码 / Figure|Table 引用 / URL / 图片路径。 */
function extractAnchors(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$[^$\n]+\$/g)) out.push(normToken(m[0]));
  for (const m of text.matchAll(/`[^`\n]+`/g)) out.push(normToken(m[0]));
  for (const m of text.matchAll(/\b(figure|table)\s+\d+\b/gi)) out.push(m[0].toLowerCase());
  for (const m of text.matchAll(/https?:\/\/[^\s)\]]+/g)) out.push(normToken(m[0]));
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) out.push(normToken(m[1]));
  return out;
}

/** 识别一个 Markdown 块的类型（多行块按首行判定；含 ≥2 个管道行的视为表格）。 */
function blockSignature(block: string): BlockSig {
  const lines = block.split("\n");
  const t = lines[0].trimStart();
  let kind: BlockKind = "para";
  if (/^#{1,6}\s/.test(t)) kind = "heading";
  else if (t.startsWith("```")) kind = "code";
  else if (t.startsWith("$$")) kind = "math";
  else if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(t)) kind = "image";
  else if (lines.filter((l) => l.includes("|")).length >= 2) kind = "table";
  else if (/^\s*([-*+]|\d+\.)\s+/.test(t)) kind = "list";
  else if (t.startsWith(">")) kind = "quote";
  return { kind, anchors: extractAnchors(block), len: block.length };
}

/**
 * 段内单调对齐（DP）：英文块与中文块按顺序做最优点配对。
 * - 允许 1 个英文块吸收连续 1–3 个中文块（LLM 拆段时就近合并）；
 * - 允许单边缺口：英文缺口（无中文译文）惩罚 -0.5、中文缺口（多余译文）惩罚 -1.0；
 * - 配对得分 = kind 匹配（同类 +2、para↔list +1、涉标题 0）+ 3×共享锚点数
 *   + 长度比拟合（0.4–1.3 倍 +2、0.2–2.5 倍 +1）- 合并惩罚（每多合并一段 -0.5）；
 * - 并列时按「小合并 > 大合并 > 英文缺口 > 中文缺口」回溯，保证确定性；
 * - 得分 < 0.5 的候选对不渲染为配对，转为 rest（宁可标「缺译文」，不显示错配）。
 */
function alignRun(enRun: string[], zhRun: string[]): PairResult {
  const n = enRun.length;
  const m = zhRun.length;
  const enSigs = enRun.map(blockSignature);
  const zhSigs = zhRun.map(blockSignature);
  // 快路径：段数相等且逐块类型一致（标题锚定后的正常情况）→ 1:1 配对。
  // 若类型不一致（如一侧漏译标题，标题块落入区间），落入下方 DP 按分匹配，
  // 避免出现「标题 ↔ 段落」这类错配。
  if (n === m && enSigs.every((s, i) => s.kind === zhSigs[i].kind)) {
    return {
      pairs: enRun.map((en, i) => ({ en, zh: zhRun[i] })),
      restEn: [],
      restZh: [],
    };
  }
  if (n === 0) return { pairs: [], restEn: [], restZh: [...zhRun] };
  if (m === 0) return { pairs: [], restEn: [...enRun], restZh: [] };

  const scoreGroup = (ei: number, zStart: number, zEnd: number): number => {
    const es = enSigs[ei];
    const zk = zhSigs[zStart].kind;
    const kind =
      zk === es.kind
        ? 2
        : es.kind === "heading" || zk === "heading"
          ? 0
          : es.kind === "para" || zk === "para"
            ? 1
            : 0;
    let anchors = 0;
    for (const a of es.anchors) {
      for (let k = zStart; k < zEnd; k++) {
        if (zhSigs[k].anchors.includes(a)) {
          anchors += 1;
          break;
        }
      }
    }
    const lenZh = zhRun.slice(zStart, zEnd).reduce((sum, b) => sum + b.length, 0);
    const r = lenZh / es.len;
    const fit = r >= 0.4 && r <= 1.3 ? 2 : r >= 0.2 && r <= 2.5 ? 1 : 0;
    const mergePenalty = (zEnd - zStart - 1) * 0.5;
    return kind + 3 * anchors + fit - mergePenalty;
  };

  const EN_GAP = -0.5;
  const ZH_GAP = -1.0;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(-Infinity),
  );
  type Move =
    | { kind: "pair"; mm: number }
    | { kind: "engap" }
    | { kind: "zhgap" };
  const back: (Move | null)[][] = Array.from({ length: n + 1 }, () =>
    new Array<Move | null>(m + 1).fill(null),
  );

  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + EN_GAP;
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + ZH_GAP;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = -Infinity;
      let move: Move | null = null;
      for (let mm = 1; mm <= 3 && j - mm >= 0; mm++) {
        const v = dp[i - 1][j - mm] + scoreGroup(i - 1, j - mm, j);
        if (v > best) {
          best = v;
          move = { kind: "pair", mm };
        }
      }
      const ev = dp[i - 1][j] + EN_GAP;
      if (ev > best) {
        best = ev;
        move = { kind: "engap" };
      }
      const zv = dp[i][j - 1] + ZH_GAP;
      if (zv > best) {
        best = zv;
        move = { kind: "zhgap" };
      }
      dp[i][j] = best;
      back[i][j] = move;
    }
  }

  let i = n;
  let j = m;
  const pairs: { en: string; zh: string }[] = [];
  const restEn: string[] = [];
  const restZh: string[] = [];
  while (i > 0 || j > 0) {
    const mv = i > 0 && j > 0 ? back[i][j] : null;
    if (mv && mv.kind === "pair") {
      const zStart = j - mv.mm;
      const s = scoreGroup(i - 1, zStart, j);
      if (s >= 0.5) {
        pairs.unshift({
          en: enRun[i - 1],
          zh: zhRun.slice(zStart, j).join("\n\n"),
        });
      } else {
        restEn.unshift(enRun[i - 1]);
        restZh.unshift(...zhRun.slice(zStart, j));
      }
      i -= 1;
      j = zStart;
    } else if (i > 0 && (mv === null || mv.kind === "engap")) {
      restEn.unshift(enRun[i - 1]);
      i -= 1;
    } else {
      restZh.unshift(zhRun[j - 1]);
      j -= 1;
    }
  }
  return { pairs, restEn, restZh };
}

/**
 * 块级对齐：标题两两按序锚定后，把标题之间的非标题区间分别做段内单调对齐。
 * 标题对本身直接配对；标题数不一致时，多余标题随所在区间按普通块处理。
 */
function alignBlocks(enB: string[], zhB: string[]): PairResult {
  const enH: number[] = [];
  const zhH: number[] = [];
  enB.forEach((b, i) => {
    if (blockSignature(b).kind === "heading") enH.push(i);
  });
  zhB.forEach((b, i) => {
    if (blockSignature(b).kind === "heading") zhH.push(i);
  });

  const pairs: { en: string; zh: string }[] = [];
  const restEn: string[] = [];
  const restZh: string[] = [];
  const consume = (r: PairResult) => {
    pairs.push(...r.pairs);
    restEn.push(...r.restEn);
    restZh.push(...r.restZh);
  };

  let es = 0;
  let zs = 0;
  const h = Math.min(enH.length, zhH.length);
  for (let k = 0; k < h; k++) {
    consume(alignRun(enB.slice(es, enH[k]), zhB.slice(zs, zhH[k])));
    pairs.push({ en: enB[enH[k]], zh: zhB[zhH[k]] });
    es = enH[k] + 1;
    zs = zhH[k] + 1;
  }
  consume(alignRun(enB.slice(es), zhB.slice(zs)));
  return { pairs, restEn, restZh };
}

/**
 * 对照模式全局配对：按翻译块逐块对齐（每块的 en↔zh 天然一一对应，即锚点），
 * 块内错位不会传播到后续块；结果按文档顺序拼接。任何一段内容都不静默丢失：
 * 缺译文进 restEn、多余译文进 restZh，由展示层完整渲染并标注。
 */
export function pairChunks(
  chunks: TranslationChunk[],
): PairResult & { enCount: number; zhCount: number } {
  const pairs: { en: string; zh: string }[] = [];
  const restEn: string[] = [];
  const restZh: string[] = [];
  let enCount = 0;
  let zhCount = 0;
  for (const c of chunks) {
    const enB = splitBlocks(c.en);
    const zhB = splitBlocks(c.zh);
    enCount += enB.length;
    zhCount += zhB.length;
    const r = alignBlocks(enB, zhB);
    pairs.push(...r.pairs);
    restEn.push(...r.restEn);
    restZh.push(...r.restZh);
  }
  return { pairs, restEn, restZh, enCount, zhCount };
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


/**
 * 把英文 Markdown 切成「正文 + 参考文献」两段，供翻译时排除参考文献（省 token）。
 * 判定：逐行扫描（跳过 ``` 与 $$ 围栏块），命中「整行只有 References/Bibliography」的标题行即切分
 * ——支持 `## REFERENCES` / `# References` / `## Bibliography` / `References` / `REFERENCES.` /
 * `## 8 REFERENCES` 等变体；整行锚定避免误判正文句子或其它小节标题。取第一个命中；
 * 命中行起（含标题）到文末为 references。未命中则整篇视为 body（保守，不丢内容）。
 */
export function splitReferences(md: string): { body: string; references: string } {
  const lines = md.split("\n");
  const RE = /^(#{1,6}\s*)?\d*\.?\s*(references|bibliography)\s*[.:]?\s*$/i;
  let idx = -1;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    if (t.startsWith("```") || t.startsWith("$$")) {
      fence = t.startsWith("```") ? "```" : "$$";
      continue;
    }
    if (RE.test(t)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { body: md, references: "" };
  return {
    body: lines.slice(0, idx).join("\n"),
    references: lines.slice(idx).join("\n"),
  };
}
