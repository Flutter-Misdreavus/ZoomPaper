import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  katexOptions,
  markdownUrlTransform,
  normalizeLatex,
  resolveImgSrc,
} from "@/lib/markdown";

interface Props {
  markdown: string;
  className?: string;
  /** 相对图片路径的基准目录（不含文件名），如论文目录；缺省则相对路径原样输出 */
  baseDir?: string;
}

/** 论文/博客/笔记 Markdown 渲染：GFM + KaTeX 公式 + 本地图片路径重写 */
export function MarkdownView({ markdown, className, baseDir }: Props) {
  return (
    <article className={`prose prose-neutral max-w-none dark:prose-invert ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        urlTransform={markdownUrlTransform}
        components={{
          img: ({ src, alt }) => <img src={resolveImgSrc(src, baseDir)} alt={alt} />,
        }}
      >
        {normalizeLatex(markdown)}
      </ReactMarkdown>
    </article>
  );
}
