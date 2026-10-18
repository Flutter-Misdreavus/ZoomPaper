import { usePreferences, paperTitle } from "@/lib/preferences";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlogPanel } from "@/components/BlogPanel";
import { TranslatePanel } from "@/components/TranslatePanel";
import { PdfViewer, type PdfViewerHandle } from "@/components/PdfViewer";
import { QaPanel, type QaPanelHandle } from "@/components/QaPanel";
import {
  addReadingTime,
  markPaperRead,
  touchPaper,
  getPaper,
  refreshPaperPublication,
  setPaperStatus,
  type Paper,
} from "@/lib/api";
import { readerCommitted, readerDisplayed } from "@/lib/readerPerformance";
import { formatDuration } from "@/lib/utils";
import { ArrowLeft, BookCheck, Clock, GitFork, MessageSquare } from "lucide-react";

interface Props {
  paperId: string;
  active?: boolean;
  retainPdf?: boolean;
  onPdfActive?: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** 外部跳入的目标页（0-based），如搜索结果/引用定位 */
  initialPageIdx?: number;
  onBack: () => void;
  refreshSignal?: number;
  onTitleChange?: (title: string) => void;
}

export function Reader({ paperId, initialPageIdx, onBack, refreshSignal, onTitleChange, active = true, retainPdf = true, onPdfActive, onBusyChange }: Props) {
  const prefs=usePreferences();
  const endMarked=useRef(false);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const qaRef = useRef<QaPanelHandle>(null);
  const [navigationTarget, setNavigationTarget] = useState<{ pageIdx: number; rects?: import("@/lib/api").AnnotationRect[] }>();
  const displayed = useCallback(() => readerDisplayed(paperId), [paperId]);

  const initialRefresh = useRef(refreshSignal);
  const loaded = useRef(false);
  const publicationRequested = useRef(false);
  const updatePaper = useCallback((next: Paper) => {
    setPaper(current => current && JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, []);
  useEffect(() => {
    if (!active || (loaded.current && initialRefresh.current === refreshSignal)) return;
    let cancelled = false;
    if (!loaded.current) setLoading(true);
    getPaper(paperId).then(p => {
      if (cancelled) return;
      loaded.current = true;
      initialRefresh.current = refreshSignal;
      setError(null);
      updatePaper(p);
      if (!publicationRequested.current) {
        publicationRequested.current = true;
        void refreshPaperPublication(paperId).then(updated => {
          if (!cancelled) setPaper(current => {
            if (!current || current.id !== updated.id || (current.venue === updated.venue && current.authors === updated.authors)) return current;
            return { ...current, venue: updated.venue, authors: updated.authors };
          });
        }).catch(() => {});
      }
    }).catch(e => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  // 缓存论文只在失效且可见时刷新，不因激活重复读取。
  }, [paperId, active, refreshSignal, updatePaper]);
  useEffect(() => { if (paper) onTitleChange?.(paperTitle(paper,"tab",prefs)); }, [paper?.title, paper?.title_zh, onTitleChange, prefs]);
  useEffect(() => { if (active) void touchPaper(paperId).catch(() => {}); }, [active, paperId]);
  useLayoutEffect(() => {
    if (active) readerCommitted(paperId);
  }, [active, paperId]);
  // 打开论文即进入「在读」状态（未读 → 在读；已读保持不变）。失败静默，不影响阅读。
  useEffect(() => {
    if (!prefs.markReading || !active || !paper || paper.reading_status === "reading" || paper.reading_status === "read") return;
    setPaperStatus(paper.id, "reading").catch(() => {});
  }, [paper, active, prefs.markReading]);

  // 标记/取消已读（时间线统计口径）
  const toggleRead = () => {
    if (!paper) return;
    markPaperRead(paper.id, paper.reading_status !== "read")
      .then(setPaper)
      .catch(() => {});
  };

  // 老用户本地可能存了已下线 tab 的值，非法时回退为 pdf
  const [readerMode, setReaderMode] = useState(() => {
    const saved = localStorage.getItem(`zoompaper.readerMode.${paperId}`);
    return saved === "blog" || saved === "translate" ? saved : "pdf";
  });
  useLayoutEffect(() => { if (active && readerMode === "pdf") onPdfActive?.(); }, [active, readerMode, onPdfActive]);
  const [visitedModes, setVisitedModes] = useState<Set<string>>(() => new Set([readerMode]));
  useEffect(() => {
    if (active) setVisitedModes(current => current.has(readerMode) ? current : new Set([...current, readerMode]));
  }, [active, readerMode]);
  const acceptPdfSelection = useCallback((text: string, pageIdx: number, rects?: import("@/lib/api").AnnotationRect[]) => qaRef.current?.acceptSelection(text, pageIdx, rects), []);
  const acceptTextSelection = useCallback((text: string, location: string) => qaRef.current?.acceptSelection(text, null, undefined, location), []);
  const blogGenerated = useCallback((path: string) => setPaper(current => current && current.blog_md_path !== path ? { ...current, blog_md_path: path } : current), []);
  const jumpPage = useCallback((pageIdx: number) => { setNavigationTarget({ pageIdx }); setReaderMode("pdf"); }, []);
  const jumpSelection = useCallback((pageIdx: number, rects?: import("@/lib/api").AnnotationRect[]) => { setNavigationTarget({ pageIdx, rects }); setReaderMode("pdf"); }, []);
  const reachEnd = useCallback(() => {
    if (prefs.markReadAtEnd && active && paper && !endMarked.current && paper.reading_status !== "read") {
      endMarked.current = true;
      void markPaperRead(paper.id, true).then(updatePaper).catch(() => { endMarked.current = false; });
    }
  }, [prefs.markReadAtEnd, active, paper?.id, paper?.reading_status, updatePaper]);
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
          <h1 className="truncate text-xl font-semibold tracking-tight">
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
            <ReadingClock paperId={paperId} total={paper.total_read_seconds} active={active} />
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
            </TabsList>
            <TabsContent value="pdf" keepMounted className="flex min-h-0 flex-col">
              {(visitedModes.has("pdf") || readerMode === "pdf") && <PdfViewer
                ref={pdfRef}
                active={active && readerMode === "pdf"}
                retainResources={retainPdf}
                onReady={displayed}
                navigationTarget={navigationTarget}
                onReachEnd={reachEnd}
                pdfPath={paper.pdf_path}
                paperId={paperId}
                initialPageIdx={initialPageIdx}
                onAskSelection={acceptPdfSelection}
              />}
            </TabsContent>
            <TabsContent value="blog" keepMounted className="min-h-0 overflow-y-auto pt-4 pr-4">
              {ready && (visitedModes.has("blog") || readerMode === "blog") && (
                <MemoBlogPanel
                  active={active && readerMode === "blog"}
                  onReady={displayed}
                  paper={paper}
                  onBlogGenerated={blogGenerated}
                  onAskSelection={acceptTextSelection}
                />
              )}
            </TabsContent>
            <TabsContent value="translate" keepMounted className="flex min-h-0 flex-1 flex-col pt-4 pr-4">
              {ready && (visitedModes.has("translate") || readerMode === "translate") && (
                <MemoTranslatePanel
                  active={active && readerMode === "translate"}
                  onReady={displayed}
                  paperId={paperId}
                  onAskSelection={acceptTextSelection}
                />
              )}
            </TabsContent>
          </Tabs>

          {/* 右列：问答（可拖拽调宽 / 收纳）；未解析时禁用 */}
          {ready ? (
            <MemoQaPanel
              active={active}
              ref={qaRef}
              paperId={paperId}
              defaultOpen={prefs.showAssistant}
              onBusyChange={onBusyChange}
              onJumpPage={jumpPage}
              onJumpToSelection={jumpSelection}
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

const MemoBlogPanel = memo(BlogPanel);
const MemoTranslatePanel = memo(TranslatePanel);
const MemoQaPanel = memo(QaPanel);

/** 计时只刷新自身，不驱动整篇内容重新渲染。 */
const ReadingClock = memo(function ReadingClock({ paperId, total, active }: { paperId: string; total: number; active: boolean }) {
  const [seconds, setSeconds] = useState(total);
  const pending = useRef(0);
  useEffect(() => { setSeconds(current => Math.max(current, total)); }, [total]);
  useEffect(() => {
    if (!active) return;
    let visible = document.visibilityState === "visible";
    const onVisibility = () => { visible = document.visibilityState === "visible"; };
    const flush = () => {
      const amount = pending.current;
      if (!amount) return;
      pending.current = 0;
      void addReadingTime(paperId, amount).catch(() => { pending.current += amount; });
    };
    const timer = setInterval(() => {
      if (!visible) return;
      pending.current += 5;
      setSeconds(current => current + 5);
      if (pending.current >= 30) flush();
    }, 5000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); flush(); };
  }, [paperId, active]);
  return <span className="flex items-center gap-1.5 text-sm text-muted-foreground" title="本篇累计阅读时长"><Clock className="h-4 w-4" strokeWidth={1.8} />已阅读 {formatDuration(seconds)}</span>;
});
