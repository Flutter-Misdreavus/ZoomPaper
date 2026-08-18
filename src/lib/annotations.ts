import { getAnnotations, saveAnnotations } from "@/lib/api";
import type { TextHighlight } from "@/lib/textAnnotate";

/** 文本标注种类（博客 / 译文）→ 论文目录下的文件名 */
export type AnnotationKind = "blog" | "translate";

export const ANNOTATION_KIND_FILE: Record<AnnotationKind, string> = {
  blog: "blog_annotations.json",
  translate: "translation_annotations.json",
};

export interface TextAnnotationsFile {
  version: number;
  highlights: TextHighlight[];
}

/** 加载某类文本标注（无文件 / 解析失败 → 空列表）。 */
export async function loadTextHighlights(
  paperId: string,
  kind: AnnotationKind,
): Promise<TextHighlight[]> {
  try {
    const raw = await getAnnotations(paperId, kind);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TextAnnotationsFile;
    if (!Array.isArray(parsed.highlights)) return [];
    return parsed.highlights.filter(
      (h): h is TextHighlight =>
        !!h &&
        typeof h.id === "string" &&
        typeof h.docKey === "string" &&
        typeof h.label === "string" &&
        typeof h.start === "number" &&
        typeof h.end === "number" &&
        typeof h.text === "string" &&
        typeof h.color === "string",
    );
  } catch {
    return [];
  }
}

/** 保存某类文本标注（全量覆盖对应文件）。 */
export async function saveTextHighlights(
  paperId: string,
  kind: AnnotationKind,
  highlights: TextHighlight[],
): Promise<void> {
  const payload: TextAnnotationsFile = { version: 1, highlights };
  await saveAnnotations(paperId, JSON.stringify(payload), kind);
}
