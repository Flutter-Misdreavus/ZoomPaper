import { convertFileSrc } from "@tauri-apps/api/core";
import type { Root } from "hast";
import { defaultUrlTransform, type UrlTransform } from "react-markdown";

/**
 * 把 LLM 输出的 LaTeX 方言归一化为 remark-math 可识别的 `$...$` / `$$...$$`。
 * Gemini / 部分 DeepSeek 输出 `\(...\)` / `\[...\]`，remark-math 不识别，会当作普通文本。
 * 另外修复两类常见输出口癖：
 * - 单行 `$$...$$`（段内闭合）：remark-math 会解析为 inline math，`\tag` 在 KaTeX 严格
 *   模式下只允许 display 模式而报错，因此统一重排为独立成段的 display 块；
 * - 裸 LaTeX 行（论文公式被剥掉定界符原样输出）：按公式特征保守识别后补 `$$` 包裹。
 * 处理前先保护围栏代码块、行内代码与原始 HTML 块，避免误判或破坏表格结构。
 */
export function normalizeLatex(markdown: string): string {
  if (!markdown) return "";
  const code: string[] = [];
  const guarded = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  const html: string[] = [];
  const isolated = protectHtmlBlocks(guarded, html);
  const normalized = (() => {
    // 定界符方言归一化可能跨行，先在整段文本上处理（HTML 块已被占位，不受影响）
    const delimiters = isolated
      // `\[...\]` -> `$$...$$`
      .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$")
      // `\(...\)` -> `$...$`
      .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");
    // 再逐行处理：裸 LaTeX 公式行补 `$$`；单行 `$$...$$` 重排为独立 display 块。
    // 需跟踪是否处于已有 $$ 块内，避免把块内公式行重复包裹。
    let inMath = false;
    return delimiters
      .split("\n")
      .map((line) => {
        const t = line.trim();
        const fenceCount = (t.match(/\$\$/g) ?? []).length;
        if (fenceCount > 0) {
          if (fenceCount % 2 === 1) inMath = !inMath;
          // 表格行内不能插入换行（会打断表格结构），保留行内公式交给 KaTeX。
          if (isTableRow(line)) return line;
          return line.replace(
            /\$\$([^\n]+?)\$\$/g,
            (_, inner: string) => `\n\n$$\n${inner.trim()}\n$$\n\n`,
          );
        }
        return inMath || !isBareLatexLine(line) ? line : `\n\n$$\n${t}\n$$\n`;
      })
      .join("\n");
  })();
  // 先还原 HTML 块（块内可能含代码占位符），再还原代码块
  return normalized
    .replace(/\u0001(\d+)\u0001/g, (_, i) => html[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

/** GFM 表格行（以 `|` 开头）。 */
function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/** CommonMark 认定的 HTML 块级标签名（type 6 起始条件）。 */
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/**
 * CommonMark 原始 HTML 块的起始行。只认块级标签（`<span>`/`<img>` 等行内标签不算），
 * 与 remark-parse 的块/行内判定保持一致。
 */
const HTML_BLOCK_START_RE = new RegExp(
  "^ {0,3}(?:" +
    "<!--|" +
    "<\\?|" +
    "<![A-Za-z]|" +
    "<!\\[CDATA\\[|" +
    "<\\/?(?:script|pre|style|textarea)(?=[\\s>])|" +
    `<\\/?(?:${HTML_BLOCK_TAGS})(?=[\\s/>])|` +
    "<\\/?[A-Za-z][^>]*>[ \\t]*$" +
    ")",
);

/**
 * 把原始 HTML 块（MinerU 把整张表输出成一行 `<table>…</table>`）整体抽出为占位符。
 * 块内公式由 {@link rehypeHtmlMath} 渲染，因此这里必须原样保留：往块内插入换行或空行会
 * 终止 CommonMark 的 HTML 块，把表格后半截甩成普通文本，公式也就再也回不来了。
 */
function protectHtmlBlocks(markdown: string, stash: string[]): string {
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length === 0) return;
    stash.push(block.join("\n"));
    out.push(`\u0001${stash.length - 1}\u0001`);
    block = [];
  };
  for (const line of markdown.split("\n")) {
    if (block.length > 0) {
      // HTML 块（type 6/7）持续到空行；空行本身不属于块
      if (line.trim() === "") {
        flush();
        out.push(line);
      } else {
        block.push(line);
      }
      continue;
    }
    if (HTML_BLOCK_START_RE.test(line)) block.push(line);
    else out.push(line);
  }
  flush();
  return out.join("\n");
}

/** rehype-raw 解析前的原始 HTML 节点（@types/hast 未声明该节点，这里按需最小定义）。 */
interface RawHtmlNode {
  type: string;
  value?: string;
  children?: RawHtmlNode[];
}

/**
 * 渲染原始 HTML 里的数学公式。
 *
 * remark-math 只在 Markdown 文本中生效：MinerU 输出的 `<table>` 属于原始 HTML 块，
 * 块内的 `$...$` 既不会被 remark-math 识别，rehype-katex 也只会处理带 `math-inline` /
 * `math-display` 类的元素，于是表格里的公式一直以 `$S_t = S_{t-1}+…$` 的字面文本显示。
 *
 * 本插件在 rehype-raw 之前运行，把原始 HTML 文本中的 `$…$` / `$$…$$` / `\(…\)` / `\[…\]`
 * 改写成 remark-math 同款元素，rehype-raw 解析后即可被 rehype-katex 正常渲染。
 */
export function rehypeHtmlMath() {
  return (tree: Root): void => {
    visitRawHtml(tree as unknown as RawHtmlNode);
  };
}

function visitRawHtml(node: RawHtmlNode): void {
  if (node.type === "raw" && typeof node.value === "string") {
    node.value = mathifyHtml(node.value);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) visitRawHtml(child);
  }
}

/** 找到 `<` 起始标签的结束位置，跳过引号内的 `>`；未闭合返回 -1。 */
function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * `html[i]` 是否是真正的 HTML 标签起始。
 * MinerU 的表格公式里会出现裸 `<`（`$L(A+F) < \frac{L}{R}$`、`$p_\psi(<\mathrm{eos}>|s_t)$`），
 * 只有当 `<` 后面确实是合法标签名时才算标签，否则留在文本里交给 mathifyText。
 */
function isTagStart(html: string, i: number): boolean {
  let j = i + 1;
  // `<!DOCTYPE…` / `<![CDATA[…` / `<?…` 都按标签处理
  if (html[j] === "!" || html[j] === "?") return true;
  if (html[j] === "/") j++;
  if (!/[A-Za-z]/.test(html[j] ?? "")) return false;
  while (j < html.length && /[A-Za-z0-9:-]/.test(html[j])) j++;
  const after = html[j];
  return after === undefined || after === ">" || after === "/" || /\s/.test(after);
}

/** 只在 HTML 文本（标签之外）里转换数学定界符，标签与属性原样保留。 */
function mathifyHtml(html: string): string {
  let out = "";
  /** 当前文本段起点（标签之间的内容） */
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<" || !isTagStart(html, i)) {
      i++;
      continue;
    }
    // 注释整段原样保留
    if (html.startsWith("<!--", i)) {
      out += mathifyText(html.slice(textStart, i));
      const end = html.indexOf("-->", i + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += html.slice(i, stop);
      i = stop;
      textStart = stop;
      continue;
    }
    const gt = findTagEnd(html, i);
    if (gt === -1) break; // 标签未闭合：其余全部当文本处理
    out += mathifyText(html.slice(textStart, i));
    const tag = html.slice(i, gt + 1);
    out += tag;
    i = gt + 1;
    textStart = i;
    // script/style/pre/textarea 的内容不是 HTML 文本，原样保留
    const rawTag = /^<\s*(script|style|pre|textarea)\b/i.exec(tag);
    if (rawTag && !/\/>\s*$/.test(tag)) {
      const close = html.toLowerCase().indexOf(`</${rawTag[1].toLowerCase()}`, i);
      if (close !== -1) {
        out += html.slice(i, close);
        i = close;
        textStart = close;
      }
    }
  }
  return out + mathifyText(html.slice(textStart));
}

/**
 * 四种数学定界符；`$…$` 要求定界符内侧不是空白（避免把 `$100 到 $200` 当公式）。
 * `\|`（KaTeX 语义为双竖线）不受末支影响，因为其两侧字符是反斜杠而非 `$`。
 */
const HTML_MATH_RE =
  /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$([^\s$](?:[^\n$]*[^\s$])?)\$/g;

/** 常见 HTML 命名实体（MinerU 输出里只出现这几类）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : Number(body.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把一段 HTML 文本里的公式替换成 remark-math 同款元素。 */
function mathifyText(text: string): string {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
  // `\$` 先占位，避免被当成定界符（如 `$\$5$`）
  const escaped: string[] = [];
  const guarded = text.replace(/\\\$/g, () => {
    escaped.push("\\$");
    return `\u0002${escaped.length - 1}\u0002`;
  });
  const withMath = guarded.replace(
    HTML_MATH_RE,
    (_match, bracket: string | undefined, dollar: string | undefined, paren: string | undefined, single: string | undefined) => {
      const tex = bracket ?? dollar ?? paren ?? single ?? "";
      const display = bracket !== undefined || dollar !== undefined;
      // 实体先解码再转义：与浏览器解析原始 HTML 的结果一致，`&amp;`/`&lt;` 不会双重转义
      const body = escapeHtml(decodeHtmlEntities(tex));
      return display
        ? `<div class="math math-display">${body}</div>`
        : `<span class="math math-inline">${body}</span>`;
    },
  );
  return withMath.replace(/\u0002(\d+)\u0002/g, (_, index) => escaped[Number(index)]);
}

/** 常见 LaTeX 命令特征（用于裸公式行识别）。 */
const LATEX_COMMAND_RE =
  /\\(frac|sum|prod|int|mathcal|mathbb|mathbf|mathrm|left|right|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|nu|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|phi|varphi|Phi|psi|Psi|omega|Omega|partial|nabla|cdot|times|leq|geq|neq|approx|sim|infty|exp|log|ln|sqrt|operatorname|text|tag|begin|end|over|underline|hat|bar|vec|tilde|prime)\b/g;

/**
 * 判断一行是否是「被剥掉定界符的裸 LaTeX 公式」。保守策略：宁可漏判不可误判——
 * 含任何中文、markdown 结构符、链接语法或已有 `$` 定界符的行一律跳过；
 * 需要 ≥2 个 LaTeX 命令特征，或行尾带 `\tag{n}`（MinerU 编号公式强特征）且 ≥1 个特征。
 */
function isBareLatexLine(line: string): boolean {
  const s = line.trim();
  if (s.length < 8) return false;
  if (s.includes("$")) return false;
  // 带 `\[...\]` / `\(...\)` 定界符的行交给后续转换，不要重复包裹
  if (s.includes("\\[") || s.includes("\\(")) return false;
  if (/[\u4e00-\u9fff]/.test(s)) return false;
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|!|\|)/.test(s)) return false;
  if (/\]\(/.test(s)) return false;
  const cmdCount = (s.match(LATEX_COMMAND_RE) ?? []).length;
  if (/\\tag\{\d+\}\s*$/.test(s)) return cmdCount >= 1;
  return cmdCount >= 2;
}

/**
 * 把正文里的 [n] 改写成 markdown 链接（渲染成 CitationBadge）。
 * 先守卫代码块与数学区域，避免公式下标 `a[0]` 被误转为引用链接。
 */
export function linkifyCitations(md: string): string {
  if (!md) return "";
  const spans: string[] = [];
  const guarded = md.replace(
    /```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^\n$]+?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g,
    (m) => {
      spans.push(m);
      return `\u0000${spans.length - 1}\u0000`;
    },
  );
  return guarded
    .replace(/\[(\d+)\]/g, "[$1](citation:$1)")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

/**
 * 把 Markdown 里图片地址含空格的 `![](path)` 用尖括号包裹为 `![](<path>)`。
 * CommonMark 的链接目标不允许裸空格（macOS 绝对路径常含空格，如 `Application Support`），
 * 不包裹会导致整行无法被解析成图片而沦为纯文本。处理前先保护代码块/行内代码。
 * `<>` 内的地址允许任意字符（除 `<>`），解析出的 src 不含尖括号，后续可正常加载。
 */
export function normalizeImageUrls(markdown: string): string {
  if (!markdown) return "";
  const code: string[] = [];
  const guarded = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  const normalized = guarded.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt, url) => {
      // 已用 <> 包裹或地址无空白则不处理
      if ((url.startsWith("<") && url.endsWith(">")) || !/\s/.test(url)) {
        return match;
      }
      return `![${alt}](<${url}>)`;
    },
  );
  return normalized.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

/**
 * react-markdown 默认只放行 https?/ircs?/mailto/xmpp；这里额外放行内部协议：
 * `asset:`（convertFileSrc 生成的本地文件 URL）与 `citation:`（问答引用标记），
 * 其余仍走默认消毒。
 */
export const markdownUrlTransform: UrlTransform = (url) => {
  if (/^(asset|citation):/i.test(url)) return url;
  return defaultUrlTransform(url);
};

/** 容错解码：react-markdown 会把链接目标里的空格等字符 percent-encode，这里还原真实路径。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 把 markdown 图片 src 转成 WebView 可加载的 URL：
 * - http(s)/asset/data/blob 等协议原样放行；
 * - 绝对本地路径 → 先解码（react-markdown 已 percent-encode 空格等）再 convertFileSrc（asset://）；
 * - 相对路径 → 用 baseDir 拼成绝对路径后同样处理（无 baseDir 则原样返回，备用能力）。
 */
export function resolveImgSrc(
  src: string | undefined,
  baseDir?: string,
): string | undefined {
  if (!src) return src;
  if (/^(https?:|asset:|data:|blob:)/i.test(src)) return src;
  if (/^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/")) {
    return convertFileSrc(safeDecode(src));
  }
  if (baseDir) {
    return convertFileSrc(safeDecode(`${baseDir}/${src.replace(/^\.\//, "")}`));
  }
  return src;
}

/** rehype-katex 配置：单条公式解析失败时红字降级显示，不抛错中断整棵渲染树。 */
export const katexOptions = { errorColor: "#dc2626" } as const;
