import { convertFileSrc } from "@tauri-apps/api/core";
import { defaultUrlTransform, type UrlTransform } from "react-markdown";

/**
 * 把 LLM 输出的 LaTeX 方言归一化为 remark-math 可识别的 `$...$` / `$$...$$`。
 * Gemini / 部分 DeepSeek 输出 `\(...\)` / `\[...\]`，remark-math 不识别，会当作普通文本。
 * 另外修复两类常见输出口癖：
 * - 单行 `$$...$$`（段内闭合）：remark-math 会解析为 inline math，`\tag` 在 KaTeX 严格
 *   模式下只允许 display 模式而报错，因此统一重排为独立成段的 display 块；
 * - 裸 LaTeX 行（论文公式被剥掉定界符原样输出）：按公式特征保守识别后补 `$$` 包裹。
 * 处理前先保护围栏代码块与行内代码，避免 `$PATH`、`$100` 被误判为公式。
 */
export function normalizeLatex(markdown: string): string {
  if (!markdown) return "";
  const code: string[] = [];
  const guarded = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  const normalized = (() => {
    // 裸 LaTeX 公式行 -> $$ 包裹（先于定界符转换，此时行内尚无 `$`）；
    // 需跟踪是否处于已有 $$ 块内，避免把块内公式行重复包裹
    let inMath = false;
    const wrapped = guarded
      .split("\n")
      .map((line) => {
        const t = line.trim();
        const fenceCount = (t.match(/\$\$/g) ?? []).length;
        if (fenceCount > 0) {
          if (fenceCount % 2 === 1) inMath = !inMath;
          return line;
        }
        return !inMath && isBareLatexLine(line) ? `\n\n$$\n${t}\n$$\n` : line;
      })
      .join("\n");
    return wrapped
      // `\[...\]` -> `$$...$$`
      .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$")
      // `\(...\)` -> `$...$`
      .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$")
      // 单行 `$$...$$` -> 独立 display 块（已有多行块内容含换行，天然不匹配）
      .replace(/\$\$([^\n]+?)\$\$/g, (_, inner) => `\n\n$$\n${inner.trim()}\n$$\n\n`);
  })();
  return normalized.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
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
