import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/MarkdownView";
import { generateBlog, type BlogLevel, type Paper } from "@/lib/api";
import { FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";

const LEVELS: { value: BlogLevel; label: string; hint: string }[] = [
  { value: "popular", label: "科普版", hint: "面向大众，类比驱动" },
  { value: "intro", label: "入门版", hint: "面向跨领域读者" },
  { value: "expert", label: "专业速读版", hint: "面向同行，提炼要点" },
];

interface Props {
  paper: Paper;
  /** 生成成功后回写 blog_md_path，让外层 paper 状态保持最新 */
  onBlogGenerated: (path: string) => void;
}

export function BlogPanel({ paper, onBlogGenerated }: Props) {
  const [blog, setBlog] = useState<string | null>(null);
  const [level, setLevel] = useState<BlogLevel>("intro");
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
        if (!cancelled) setBlog(text);
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
      const md = await generateBlog(paper.id, level);
      setBlog(md);
      // blog.md 落盘在 paper.md 同级目录，与后端保持一致
      const blogPath = paper.md_path.replace(/[^/\\]+$/, "blog.md");
      onBlogGenerated(blogPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg bg-muted p-[3px]">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              title={l.hint}
              onClick={() => setLevel(l.value)}
              className={`pressable rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                level === l.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
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
        <MarkdownView markdown={blog} />
      ) : (
        !error && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
            <FileText className="h-10 w-10" />
            <p className="text-sm">还没有博客，选择层级后点击「生成博客」</p>
          </div>
        )
      )}
    </div>
  );
}
