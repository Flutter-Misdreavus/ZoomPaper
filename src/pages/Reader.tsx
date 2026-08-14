import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlogPanel } from "@/components/BlogPanel";
import { MarkdownView } from "@/components/MarkdownView";
import { QaPanel } from "@/components/QaPanel";
import { getPaper, getPaperMd, type Paper } from "@/lib/api";
import { ArrowLeft } from "lucide-react";

interface Props {
  paperId: string;
  onBack: () => void;
}

export function Reader({ paperId, onBack }: Props) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [md, setMd] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const p = await getPaper(paperId);
        if (cancelled) return;
        setPaper(p);
        if (p.parse_status === "ready") {
          const markdown = await getPaperMd(paperId);
          if (!cancelled) setMd(markdown);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  const ready = paper?.parse_status === "ready";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="pressable">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight">
            {paper?.title ?? "加载中…"}
          </h1>
          {paper?.authors && (
            <p className="text-sm text-muted-foreground">{paper.authors}</p>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : !ready ? (
        <div className="rounded-md border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
          论文尚未解析完成，请先在论文库中完成解析
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* 左列：原文 / AI 博客 */}
          <Tabs defaultValue="md" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="md">原文</TabsTrigger>
              <TabsTrigger value="blog">AI 博客</TabsTrigger>
            </TabsList>
            <TabsContent value="md" keepMounted className="min-h-0 overflow-y-auto pt-4 pr-4">
              <MarkdownView markdown={md} />
            </TabsContent>
            <TabsContent value="blog" keepMounted className="min-h-0 overflow-y-auto pt-4 pr-4">
              {paper && (
                <BlogPanel
                  paper={paper}
                  onBlogGenerated={(path) =>
                    setPaper({ ...paper, blog_md_path: path })
                  }
                />
              )}
            </TabsContent>
          </Tabs>

          {/* 右列：问答（可拖拽调宽 / 收纳） */}
          <QaPanel paperId={paperId} />
        </div>
      )}
    </div>
  );
}
