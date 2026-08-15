import { convertFileSrc } from "@tauri-apps/api/core";
import { defaultUrlTransform, type UrlTransform } from "react-markdown";

/**
 * 把 LLM 输出的 LaTeX 方言归一化为 remark-math 可识别的 `$...$` / `$$...$$`。
 * Gemini / 部分 DeepSeek 输出 `\(...\)` / `\[...\]`，remark-math 不识别，会当作普通文本。
 * 处理前先保护围栏代码块与行内代码，避免 `$PATH`、`$100` 被误判为公式。
 */
export function normalizeLatex(markdown: string): string {
  if (!markdown) return "";
  const code: string[] = [];
  const guarded = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  const normalized = guarded
    // `\[...\]` -> `$$...$$`
    .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$")
    // `\(...\)` -> `$...$`
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");
  return normalized.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
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
