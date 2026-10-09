import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlogPanel } from "@/components/BlogPanel";
import { TranslatePanel } from "@/components/TranslatePanel";
import { FeynmanChat } from "@/components/FeynmanChat";
import { PdfViewer, type PdfViewerHandle } from "@/components/PdfViewer";
import { QaPanel, type QaPanelHandle } from "@/components/QaPanel";
import {
  addReadingTime,
  markPaperRead,
  openPaperForReading,
  setPaperStatus,
  type Paper,
} from "@/lib/api";
import { displayPaperTitle, formatDuration } from "@/lib/utils";
import { BookCheck, Clock, GitFork, MessageSquare } from "lucide-react";

interface Props {
  paperId: string;
  /** 外部跳入的目标页（0-based），如搜索结果/引用定位 */
  initialPageIdx?: number;
  /** 复用已有标签并带页码跳转时递增，触发 jumpToPage */
  jumpNonce: number;
  /** 是否为当前激活标签：非激活标签不计阅读时长 */
  active: boolean;
  /** 论文元数据加载完成后回调（标签条回填标题） */
  onPaperLoaded: (paper: Paper) => void;
}

export function Reader({ paperId, initialPageIdx, jumpNonce, active, onPaperLoaded }: Props) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const qaRef = useRef<QaPanelHandle>(null);

  useEffect(() => {
    let cancelled = false;
    openPaperForReading(paperId)
      .then((p) => {
        if (cancelled) return;
        setPaper(p);
        onPaperLoaded(p);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onPaperLoaded 由父组件稳定传入
  }, [paperId]);

  // 复用已有标签并指定页码时，在已挂载的阅读器内跳页
  const lastJumpNonceRef = useRef(jumpNonce);
  useEffect(() => {
    if (jumpNonce === lastJumpNonceRef.current) return;
    lastJumpNonceRef.current = jumpNonce;
    if (initialPageIdx != null) pdfRef.current?.jumpToPage(initialPageIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅以 jumpNonce 为跳转信号
  }, [jumpNonce]);

  // 打开论文即进入「在读」状态（未读 → 在读；已读保持不变）。失败静默，不影响阅读。
  useEffect(() => {
    if (!paper || paper.reading_status === "reading" || paper.reading_status === "read") return;
    setPaperStatus(paper.id, "reading").catch(() => {});
  }, [paper]);

  // 阅读时长累计：仅页面可见且为激活标签时计时，每 30s 上报一次，卸载/换论文/切标签时上报零头。失败静默。
  const [sessionSeconds, setSessionSeconds] = useState(0);
  useEffect(() => {
    if (!paper) return;
    const pid = paper.id;
    setSessionSeconds(0);
    let pending = 0;
    let visible = document.visibilityState === "visible" && active;
    const onVis = () => {
      visible = document.visibilityState === "visible" && active;
    };
    const flush = () => {
      if (pending <= 0) return;
      const s = pending;
      pending = 0;
      addReadingTime(pid, s).catch(() => {
        pending += s; // 上报失败则留待下次
      });
    };
    document.addEventListener("visibilitychange", onVis);
    const timer = setInterval(() => {
      if (!visible) return;
      pending += 5;
      setSessionSeconds((v) => v + 5);
      if (pending >= 30) flush();
    }, 5000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以论文 id 与激活状态为计时边界
  }, [paper?.id, active]);

  // 标记/取消已读（时间线统计口径）
  const toggleRead = () => {
    if (!paper) return;
    markPaperRead(paper.id, paper.reading_status !== "read")
      .then(setPaper)
      .catch(() => {});
  };

  const ready = paper?.parse_status === "ready";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight">
            {paper ? displayPaperTitle(paper.title) : "加载中…"}
          </h1>
          {paper?.authors && (
            <p className="text-sm text-muted-foreground">{paper.authors}</p>
          )}
        </div>
        {paper && (
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {paper.github_url && (
              <IconTooltip label="打开 GitHub 项目" side="bottom"><Button
                variant="ghost"
                size="icon"
                onClick={() => void openUrl(paper.github_url!)}
                aria-label="打开 GitHub 项目"
                className="pressable"
              >
                <GitFork className="h-4 w-4" />
              </Button></IconTooltip>
            )}
            <span
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              title="本篇累计阅读时长"
            >
              <Clock className="h-4 w-4" strokeWidth={1.8} />
              已阅读 {formatDuration(paper.total_read_seconds + sessionSeconds)}
            </span>
            <Button
              variant={paper.reading_status === "read" ? "secondary" : "outline"}
              size="sm"
              onClick={toggleRead}
              className="pressable"
            >
              <BookCheck className="h-4 w-4" strokeWidth={1.8} />
              {paper.reading_status === "read" ? "取消已读" : "标记已读"}
            </Button>
          </div>
        )}
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
            <div className="ml-2 flex w-10 shrink-0 items-start justify-center py-3 text-muted-foreground" title="解析完成后可用论文助手">
              <MessageSquare className="h-4 w-4" />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
