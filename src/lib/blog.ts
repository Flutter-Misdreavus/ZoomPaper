/**
 * AI 博客「深度剖析」栏目：六个分析维度 + 组合 Markdown 解析。
 *
 * 后端把科普版博客正文与六维剖析拼接为单一 `blog.md`：正文在前，行首
 * `# 深度剖析`（H1）标记之后为六个 `## <heading>` 段落（英文标题为解析锚点，
 * 界面显示中文标签）。本模块负责切分正文与六段剖析。
 */

/** 深度剖析的六个维度 key */
export type AnalysisKey =
  | "task"
  | "challenge"
  | "insight"
  | "novelty"
  | "flaw"
  | "motivation";

export interface AnalysisTag {
  key: AnalysisKey;
  /** 界面中文标签 */
  label: string;
  /** 博客 Markdown 中的段落标题（解析锚点） */
  heading: string;
}

export const ANALYSIS_TAGS: AnalysisTag[] = [
  { key: "task", label: "任务", heading: "Task" },
  { key: "challenge", label: "挑战", heading: "Challenge" },
  { key: "insight", label: "洞见", heading: "Insight" },
  { key: "novelty", label: "创新", heading: "Novelty" },
  { key: "flaw", label: "潜在缺陷", heading: "Potential Flaw" },
  { key: "motivation", label: "动机", heading: "Motivation" },
];

/** 博客正文与深度剖析的分界标记（与后端 `join_blog` 保持一致） */
const ANALYSIS_MARKER = "# 深度剖析";

export interface ParsedBlog {
  /** 博客正文（剖析标记之前的内容，已去首尾空白） */
  body: string;
  /** 六段剖析内容；旧版博客无剖析标记时为 null */
  sections: Partial<Record<AnalysisKey, string>> | null;
}

/**
 * 解析组合博客 Markdown：
 * - 按行首 `# 深度剖析` 标记切分正文与剖析区，无标记视为旧版博客（仅正文）；
 * - 剖析区按六个 `## <heading>` 段首切段，容忍 `## Task：xxx` 之类带冒号的标题，
 *   段落顺序不强制；某段缺失记为空串，交由 UI 占位提示。
 */
export function parseBlog(md: string): ParsedBlog {
  const lines = md.split("\n");
  const markerIdx = lines.findIndex((line) => line.trim() === ANALYSIS_MARKER);
  if (markerIdx === -1) {
    return { body: md, sections: null };
  }

  const body = lines.slice(0, markerIdx).join("\n").trim();
  const analysisLines = lines.slice(markerIdx + 1);

  // 收集六个段落标题的实际行号（容忍标题后跟冒号/中文说明）
  const found: { tag: AnalysisTag; lineIdx: number }[] = [];
  analysisLines.forEach((line, i) => {
    if (!/^##\s+/.test(line)) return;
    const rest = line.replace(/^##\s+/, "").trim();
    for (const tag of ANALYSIS_TAGS) {
      if (rest === tag.heading || rest.startsWith(`${tag.heading}：`)) {
        found.push({ tag, lineIdx: i });
        break;
      }
    }
  });
  found.sort((a, b) => a.lineIdx - b.lineIdx);

  const sections: Partial<Record<AnalysisKey, string>> = {};
  ANALYSIS_TAGS.forEach((tag) => {
    const pos = found.findIndex((f) => f.tag.key === tag.key);
    if (pos === -1) {
      sections[tag.key] = "";
      return;
    }
    const start = found[pos].lineIdx + 1;
    const end = found[pos + 1]?.lineIdx ?? analysisLines.length;
    sections[tag.key] = analysisLines.slice(start, end).join("\n").trim();
  });

  return { body, sections };
}
