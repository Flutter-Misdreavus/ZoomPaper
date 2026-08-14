import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc } from "@tauri-apps/api/core";

// 把绝对本地路径转成 WebView 可加载的 asset URL；已是 http/asset 的保持原样。
export function resolveImgSrc(src: string | undefined): string | undefined {
  if (!src) return src;
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("asset:")) {
    return src;
  }
  return convertFileSrc(src);
}

interface Props {
  markdown: string;
  className?: string;
}

/** 论文/博客 Markdown 渲染：GFM + 本地图片路径重写 */
export function MarkdownView({ markdown, className }: Props) {
  return (
    <article className={`prose prose-neutral max-w-none dark:prose-invert ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => <img src={resolveImgSrc(src)} alt={alt} />,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
