import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlogPanel } from "@/components/BlogPanel";
import { TranslatePanel } from "@/components/TranslatePanel";
import { FeynmanChat } from "@/components/FeynmanChat";
import { PdfViewer, type PdfViewerHandle } from "@/components/PdfViewer";
import { QaPanel, type QaPanelHandle } from "@/components/QaPanel";
import { getPaper, type Paper } from "@/lib/api";
import { ArrowLeft } from "lucide-react";

interface Props {
  paperId: string;
  /** 外部跳入的目标页（0-based），如搜索结果/引用定位 */
  initialPageIdx?: number;
  onBack: () => void;
}

export function Reader({ paperId, initialPageIdx, onBack }: Props) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const qaRef = useRef<QaPanelHandle>(null);

  useEffect(() => {
    let cancelled = false;
    getPaper(paperId)
      .then((p) => !cancelled && setPaper(p))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
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
          <Skeleton className="h-[60vh] w-full" />
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : paper ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* 左列：原文 PDF / AI 博客 */}
          <Tabs defaultValue="pdf" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="pdf">原文</TabsTrigger>
              <TabsTrigger
                value="blog"
                disabled={!ready}
                title={ready ? undefined : "解析完成后可用"}
              >
                AI 博客
              </TabsTrigger>
              <TabsTrigger
                value="translate"
                disabled={!ready}
                title={ready ? undefined : "解析完成后可用"}
              >
                AI 翻译
              </TabsTrigger>
              <TabsTrigger
                value="feynman"
                disabled={!ready}
                title={ready ? undefined : "解析完成后可用"}
              >
                费曼学习法
              </TabsTrigger>
            </TabsList>
            <TabsContent value="pdf" keepMounted className="flex min-h-0 flex-col">
              <PdfViewer
                ref={pdfRef}
                pdfPath={paper.pdf_path}
                paperId={paperId}
                initialPageIdx={initialPageIdx}
                onAskSelection={(text, pageIdx, rects) =>
                  qaRef.current?.acceptSelection(text, pageIdx, rects)
                }
              />
            </TabsContent>
            <TabsContent value="blog" keepMounted className="min-h-0 overflow-y-auto pt-4 pr-4">
              {ready && (
                <BlogPanel
                  paper={paper}
                  onBlogGenerated={(path) =>
                    setPaper({ ...paper, blog_md_path: path })
                  }
                  onAskSelection={(text, location) =>
                    qaRef.current?.acceptSelection(text, null, undefined, location)
                  }
                />
              )}
            </TabsContent>
            <TabsContent value="translate" keepMounted className="flex min-h-0 flex-1 flex-col pt-4 pr-4">
              {ready && (
                <TranslatePanel
                  paperId={paperId}
                  onAskSelection={(text, location) =>
                    qaRef.current?.acceptSelection(text, null, undefined, location)
                  }
                />
              )}
            </TabsContent>
            <TabsContent value="feynman" keepMounted className="flex min-h-0 flex-1 flex-col pt-4 pr-4">
              {ready && <FeynmanChat paperId={paperId} />}
            </TabsContent>
          </Tabs>

          {/* 右列：问答（可拖拽调宽 / 收纳）；未解析时禁用 */}
          {ready ? (
            <QaPanel
              ref={qaRef}
              paperId={paperId}
              onJumpPage={(idx) => pdfRef.current?.jumpToPage(idx)}
              onJumpToSelection={(pageIdx, rects) =>
                pdfRef.current?.jumpToSelection(pageIdx, rects)
              }
            />
          ) : (
            <div className="ml-2 flex w-10 shrink-0 items-start justify-center rounded-lg border border-dashed py-3 text-muted-foreground">
              <span
                className="text-xs [writing-mode:vertical-rl]"
                title="解析完成后可用问答"
              >
                问答（需先解析）
              </span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
