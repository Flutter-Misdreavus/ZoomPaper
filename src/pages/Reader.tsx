import { usePreferences, paperTitle } from "@/lib/preferences";
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
  getPaper,
  refreshPaperPublication,
  setPaperStatus,
  type Paper,
} from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import { ArrowLeft, BookCheck, Clock, GitFork, MessageSquare } from "lucide-react";

interface Props {
  paperId: string;
  active?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** 外部跳入的目标页（0-based），如搜索结果/引用定位 */
  initialPageIdx?: number;
  onBack: () => void;
  refreshSignal?: number;
  onTitleChange?: (title: string) => void;
}

export function Reader({ paperId, initialPageIdx, onBack, refreshSignal, onTitleChange, active = true, onBusyChange }: Props) {
  const prefs=usePreferences();
  const endMarked=useRef(false);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const qaRef = useRef<QaPanelHandle>(null);

  useEffect(() => {
    let cancelled = false;
    getPaper(paperId)
      .then((p) => {
        if (cancelled) return;
        setPaper(p);
        refreshPaperPublication(paperId).then((updated) => {
          if (!cancelled) setPaper((current) => current?.id === updated.id ? { ...current, venue: updated.venue, authors: updated.authors } : current);
        }).catch(() => {});
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  useEffect(() => {
    let canceled = false;
    getPaper(paperId).then((updated) => { if (!canceled) setPaper(updated); }).catch(() => {});
    return () => { canceled = true; };
  }, [paperId, refreshSignal]);
  useEffect(() => { if (paper) onTitleChange?.(paperTitle(paper,"tab",prefs)); }, [paper?.title, paper?.title_zh, onTitleChange, prefs]);

  useEffect(() => {
    if (!active) return;
    let canceled = false;
    void openPaperForReading(paperId).then(updated => { if (!canceled) setPaper(updated); }).catch(() => {});
    return () => { canceled = true; };
  }, [active, paperId]);

  // 打开论文即进入「在读」状态（未读 → 在读；已读保持不变）。失败静默，不影响阅读。
  useEffect(() => {
    if (!prefs.markReading || !active || !paper || paper.reading_status === "reading" || paper.reading_status === "read") return;
    setPaperStatus(paper.id, "reading").catch(() => {});
  }, [paper, active, prefs.markReading]);

  // 阅读时长累计：仅页面可见时计时，每 30s 上报一次，卸载/换论文时上报零头。失败静默。
  const [sessionSeconds, setSessionSeconds] = useState(0);
  useEffect(() => {
    if (!paper || !active) return;
    const pid = paper.id;
    setSessionSeconds(0);
    let pending = 0;
    let visible = document.visibilityState === "visible";
    const onVis = () => {
      visible = document.visibilityState === "visible";
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以论文 id 为计时边界
  }, [paper?.id, active]);

  // 标记/取消已读（时间线统计口径）
  const toggleRead = () => {
    if (!paper) return;
    markPaperRead(paper.id, paper.reading_status !== "read")
      .then(setPaper)
      .catch(() => {});
  };

  const [readerMode, setReaderMode] = useState(() => localStorage.getItem(`zoompaper.readerMode.${paperId}`) ?? "pdf");
  const ready = paper?.parse_status === "ready";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <IconTooltip label="返回论文库" side="bottom"><Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="返回论文库"
          className="pressable"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button></IconTooltip>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight">
            {paper ? paperTitle(paper,"tab",prefs) : "加载中…"}
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
          <Tabs value={readerMode} onValueChange={value => { setReaderMode(String(value)); localStorage.setItem(`zoompaper.readerMode.${paperId}`, String(value)); }} className="flex min-h-0 min-w-0 flex-1 flex-col">
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
              {visited && <PdfViewer
                ref={pdfRef}
                active={active && readerMode === "pdf"}
                onReachEnd={() => {if(prefs.markReadAtEnd && active && !endMarked.current && paper.reading_status!=="read"){endMarked.current=true;void markPaperRead(paper.id,true).then(setPaper).catch(()=>{endMarked.current=false;});}}}
                pdfPath={paper.pdf_path}
                paperId={paperId}
                initialPageIdx={initialPageIdx}
                onAskSelection={(text, pageIdx, rects) =>
                  qaRef.current?.acceptSelection(text, pageIdx, rects)
                }
              />}
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
              defaultOpen={prefs.showAssistant}
              onBusyChange={onBusyChange}
              onJumpPage={(idx) => { setReaderMode("pdf"); requestAnimationFrame(() => pdfRef.current?.jumpToPage(idx)); }}
              onJumpToSelection={(pageIdx, rects) => { setReaderMode("pdf"); requestAnimationFrame(() => pdfRef.current?.jumpToSelection(pageIdx, rects)); }}
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
