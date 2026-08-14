import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Minus, Plus } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const SCALE_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

export interface PdfViewerHandle {
  /** 0-based 页码，对齐后端 page_idx */
  jumpToPage: (pageIdx: number) => void;
}

interface Props {
  pdfPath: string;
  /** 初始跳入的目标页（0-based），文档加载后自动跳转 */
  initialPageIdx?: number;
}

interface PageSlot {
  /** 未渲染时占位的宽高比高度（相对容器宽），渲染后由 canvas 决定 */
  width: number;
  height: number;
}

/**
 * 论文 PDF 直出：连续滚动 + 懒渲染（接近视口才 render canvas）。
 * 数据经 fetch(asset URL) → arrayBuffer 加载，避开 asset:// 协议的 range 请求兼容问题。
 */
export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { pdfPath, initialPageIdx },
  ref,
) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [slots, setSlots] = useState<PageSlot[]>([]);
  const [scale, setScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpFlash, setJumpFlash] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderedRef = useRef<Set<number>>(new Set());
  const effectiveScale = scale * fitScale;

  // 加载文档
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    (async () => {
      setLoading(true);
      setError(null);
      setDoc(null);
      renderedRef.current.clear();
      try {
        const resp = await fetch(convertFileSrc(pdfPath));
        if (!resp.ok) throw new Error(`读取 PDF 失败（${resp.status}）`);
        const data = await resp.arrayBuffer();
        task = pdfjs.getDocument({ data });
        const docProxy = await task.promise;
        if (cancelled) return;

        // 逐页取原始尺寸，建立占位
        const pageSlots: PageSlot[] = [];
        for (let i = 1; i <= docProxy.numPages; i++) {
          const page = await docProxy.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          pageSlots.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) return;
        setSlots(pageSlots);
        setDoc(docProxy);
        setScale(1);
        setCurrentPage(1);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [pdfPath]);

  // fit-width：容器宽 / 第一页原始宽
  useEffect(() => {
    if (!slots.length || !scrollRef.current) return;
    const el = scrollRef.current;
    const update = () => {
      // 留出内边距与滚动条余量
      setFitScale((el.clientWidth - 32) / slots[0].width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [slots]);

  // 懒渲染 + 当前页跟踪
  useEffect(() => {
    if (!doc || !scrollRef.current) return;
    const root = scrollRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIdx);
          if (entry.isIntersecting && !renderedRef.current.has(idx)) {
            renderedRef.current.add(idx);
            void renderPage(doc, idx, effectiveScale);
          }
        }
      },
      { root, rootMargin: "600px 0px" },
    );
    const tracker = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setCurrentPage(Number((entry.target as HTMLElement).dataset.pageIdx) + 1);
          }
        }
      },
      { root, rootMargin: "-40% 0px -40% 0px" },
    );
    pageRefs.current.forEach((el) => {
      if (el) {
        observer.observe(el);
        tracker.observe(el);
      }
    });
    return () => {
      observer.disconnect();
      tracker.disconnect();
    };
  }, [doc, slots, effectiveScale]);

  // 缩放变化后强制重绘已渲染页
  useEffect(() => {
    if (!doc) return;
    renderedRef.current.clear();
    pageRefs.current.forEach((el, idx) => {
      if (el) {
        const canvas = el.querySelector("canvas");
        if (canvas) canvas.remove();
      }
      void idx;
    });
    // 触发懒渲染 observer 重新评估：对可见页直接渲染
    pageRefs.current.forEach((el, idx) => {
      if (!el || !scrollRef.current) return;
      const r = el.getBoundingClientRect();
      const root = scrollRef.current.getBoundingClientRect();
      if (r.bottom > root.top - 600 && r.top < root.bottom + 600) {
        renderedRef.current.add(idx);
        void renderPage(doc, idx, effectiveScale);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveScale]);

  async function renderPage(
    docProxy: pdfjs.PDFDocumentProxy,
    idx: number,
    s: number,
  ) {
    const container = pageRefs.current[idx];
    if (!container || container.querySelector("canvas")) return;
    const page = await docProxy.getPage(idx + 1);
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = "block h-auto w-full";
    container.style.aspectRatio = "";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  }

  function jumpToPage(pageIdx: number) {
    const el = pageRefs.current[pageIdx];
    if (!el || !scrollRef.current) return;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    setCurrentPage(pageIdx + 1);
    setJumpFlash(pageIdx);
    window.setTimeout(() => setJumpFlash(null), 1200);
  }

  useImperativeHandle(ref, () => ({ jumpToPage }));

  // 文档就绪后跳到外部指定页（搜索/引用定位）
  useEffect(() => {
    if (doc && initialPageIdx != null) {
      jumpToPage(initialPageIdx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pt-4 pr-4">
        <Skeleton className="h-[70vh] w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-4 mr-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex items-center justify-end gap-2 pt-2 pr-4">
        <span className="text-xs text-muted-foreground tabular-nums">
          {currentPage} / {slots.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="pressable h-7 w-7"
          disabled={scale <= MIN_SCALE}
          onClick={() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP))}
          title="缩小"
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="w-12 text-center text-xs text-muted-foreground tabular-nums">
          {Math.round(effectiveScale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="pressable h-7 w-7"
          disabled={scale >= MAX_SCALE}
          onClick={() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP))}
          title="放大"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 连续滚动页面 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pt-2 pr-4 pb-4">
        <div className="flex flex-col items-center gap-3">
          {slots.map((slot, idx) => (
            <div
              key={idx}
              data-page-idx={idx}
              ref={(el) => {
                pageRefs.current[idx] = el;
              }}
              className={`w-full max-w-full overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border transition-shadow ${
                jumpFlash === idx ? "ring-2 ring-primary" : ""
              }`}
              style={{ aspectRatio: `${slot.width} / ${slot.height}` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
