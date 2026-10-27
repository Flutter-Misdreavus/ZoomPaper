import { AnnotatableImage } from "@/components/ImageAnnotationViewer";
import { memo } from "react";
import type { VFile } from "vfile";
import { performanceEnabled, recordReaderPerformance } from "@/lib/readerPerformance";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import {
  katexOptions,
  markdownUrlTransform,
  normalizeImageUrls,
  normalizeLatex,
  rehypeHtmlMath,
  resolveImgSrc,
} from "@/lib/markdown";

interface Props {
  markdown: string;
  className?: string;
  /** 相对图片路径的基准目录（不含文件名），如论文目录；缺省则相对路径原样输出 */
  baseDir?: string;
  enableImageAnnotations?: boolean;
}

/** 论文/博客/笔记 Markdown 渲染：GFM + KaTeX 公式 + 本地图片路径重写 */
export const MarkdownView = memo(function MarkdownView({ markdown, className, baseDir, enableImageAnnotations = false }: Props) {
  return (
    <article key={markdown} className={`prose prose-neutral reading-prose max-w-none dark:prose-invert ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[measureStart, remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHtmlMath, rehypeRaw, [rehypeKatex, katexOptions], measureEnd]}
        urlTransform={markdownUrlTransform}
        components={{
          img: ({ src, alt }) => enableImageAnnotations ? <AnnotatableImage src={src} alt={alt} /> : <img src={resolveImgSrc(src, baseDir)} alt={alt} />,
        }}
      >
        {normalizeLatex(normalizeImageUrls(markdown))}
      </ReactMarkdown>
    </article>
  );
});
function measureStart() {
  return (_tree: unknown, file: VFile) => { if (performanceEnabled()) file.data.readerStart = performance.now(); };
}
function measureEnd() {
  return (_tree: unknown, file: VFile) => { if (typeof file.data.readerStart === "number") recordReaderPerformance("markdown", file.data.readerStart); };
}
