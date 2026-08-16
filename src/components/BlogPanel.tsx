import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/MarkdownView";
import { generateBlog, type Paper } from "@/lib/api";
import {
  ANALYSIS_TAGS,
  parseBlog,
  type AnalysisKey,
  type ParsedBlog,
} from "@/lib/blog";
import { FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";

interface Props {
  paper: Paper;
  /** 生成成功后回写 blog_md_path，让外层 paper 状态保持最新 */
  onBlogGenerated: (path: string) => void;
}

export function BlogPanel({ paper, onBlogGenerated }: Props) {
  const [blog, setBlog] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedBlog | null>(null);
  const [activeKey, setActiveKey] = useState<AnalysisKey>("task");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已有博客：经 asset 协议读回 blog.md
  useEffect(() => {
    if (!paper.blog_md_path) return;
    let cancelled = false;
    setLoading(true);
    fetch(convertFileSrc(paper.blog_md_path))
      .then((r) => {
        if (!r.ok) throw new Error(`读取博客失败（${r.status}）`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) {
          setBlog(text);
          setParsed(parseBlog(text));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paper.blog_md_path]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const md = await generateBlog(paper.id);
      setBlog(md);
      setParsed(parseBlog(md));
      // blog.md 落盘在 paper.md 同级目录，与后端保持一致
      const blogPath = paper.md_path.replace(/[^/\\]+$/, "blog.md");
      onBlogGenerated(blogPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  // 论文目录：博客与 paper.md 同目录，相对图片路径（images/...）以此为基准解析
  const baseDir = paper.md_path.replace(/[^/\\]+$/, "").replace(/[\\/]+$/, "");

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  const sections = parsed?.sections ?? null;
  const activeText = (sections && sections[activeKey]) || null;

  return (
    <div className="flex flex-col gap-5">
      {/* 操作区 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={handleGenerate} disabled={generating} size="sm">
          {generating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : blog ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {generating ? "生成中…" : blog ? "重新生成" : "生成博客"}
        </Button>
        {blog && !sections && (
          <span className="text-xs text-muted-foreground">
            该博客由旧版本生成，缺少深度剖析，可点击「重新生成」
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {generating && !blog ? (
        <div className="flex flex-col gap-3 pt-2">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : blog ? (
        <>
          {/* 深度剖析窗口：上方 Tab 标签，下方对应维度内容 */}
          {sections && (
            <div className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
              <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
                <span className="mr-1 text-sm font-semibold">深度剖析</span>
                <div className="inline-flex rounded-lg bg-muted p-[3px]">
                  {ANALYSIS_TAGS.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setActiveKey(t.key)}
                      className={`pressable rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                        activeKey === t.key
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 p-4">
                {activeText ? (
                  <MarkdownView markdown={activeText} baseDir={baseDir} />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    该部分内容缺失，可点击「重新生成」获取
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 博客正文 */}
          <div className="flex flex-col gap-2 border-t pt-5">
            <h2 className="text-base font-semibold">博客正文</h2>
            <MarkdownView markdown={parsed?.body ?? blog} baseDir={baseDir} />
          </div>
        </>
      ) : (
        !error && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
            <FileText className="h-10 w-10" />
            <p className="text-sm">还没有博客，点击「生成博客」即可获得科普版正文与深度剖析</p>
          </div>
        )
      )}
    </div>
  );
}
