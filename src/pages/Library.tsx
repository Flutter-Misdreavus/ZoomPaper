import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Loader2, Plus } from "lucide-react";
import { importPdf, listPapers, parsePdf, type Paper } from "@/lib/api";

const STATUS_STYLE: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  ready: { label: "已解析", variant: "default" },
  parsing: { label: "解析中…", variant: "secondary" },
  unparsed: { label: "未解析", variant: "outline" },
  failed: { label: "解析失败", variant: "destructive" },
};

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

interface Props {
  onOpenPaper: (id: string) => void;
}

export function Library({ onOpenPaper }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPapers(await listPapers());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleImport() {
    const file = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof file !== "string") return;

    setImporting(true);
    setError(null);
    try {
      const paper = await importPdf(file);
      setParsingId(paper.id);
      try {
        await parsePdf(paper.id);
      } catch (e) {
        setError(`导入成功，但解析失败：${e}`);
      }
      await refresh();
    } catch (e) {
      setError(`导入失败：${e}`);
    } finally {
      setImporting(false);
      setParsingId(null);
    }
  }

  async function handleParse(paperId: string) {
    setParsingId(paperId);
    setError(null);
    try {
      await parsePdf(paperId);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setParsingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">论文库</h1>
          <p className="text-sm text-muted-foreground">
            本地优先的论文阅读与知识管理
          </p>
        </div>
        <Button onClick={handleImport} disabled={importing}>
          {importing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          导入论文
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : papers.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
            <FileText className="h-10 w-10" />
            <p>还没有论文，点击「导入论文」开始</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {papers.map((paper) => {
            const st = STATUS_STYLE[paper.parse_status] ?? STATUS_STYLE.unparsed;
            const parsing = paper.parse_status === "parsing" || parsingId === paper.id;
            return (
              <Card
                key={paper.id}
                className="cursor-pointer transition-colors hover:border-primary/40"
                onClick={() => onOpenPaper(paper.id)}
              >
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold">{paper.title}</h3>
                      <Badge variant={st.variant}>{st.label}</Badge>
                    </div>
                    {paper.abstract && (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {paper.abstract}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {formatDate(paper.created_at)}
                    </p>
                  </div>
                  {paper.parse_status !== "ready" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={parsing}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleParse(paper.id);
                      }}
                    >
                      {parsing ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : null}
                      解析
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
