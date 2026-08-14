import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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

/** WebKit 非标准捏合手势事件（gesturestart/change/end） */
interface GestureEventLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
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
  // 设备像素比（封顶 2 控制内存）：Retina 屏需以更高密度渲染 canvas 后备缓冲
  const [dpr, setDpr] = useState(() => Math.min(window.devicePixelRatio || 1, 2));

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderedRef = useRef<Set<number>>(new Set());
  const effectiveScale = scale * fitScale;

  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  // 供一次性注册的原生 wheel/gesture 监听读取最新 scale
  const scaleRef = useRef(scale);
  // 捏合手势起始 scale
  const baseScaleRef = useRef(scale);
  // 缩放锚点：在 DOM 提交后据此校正滚动，使光标下的内容点保持不动
  const zoomAnchorRef = useRef<{
    px: number;
    py: number;
    fx: number;
    fy: number;
  } | null>(null);

  // 保持 scaleRef 与 state 同步（按钮点击也走这里刷新）
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // 以光标/手势中心为锚点缩放：记录内容比例锚点，DOM 提交后校正滚动
  function zoomAround(px: number, py: number, next: number) {
    const el = scrollRef.current;
    if (!el) return;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (clamped === scaleRef.current) return;
    zoomAnchorRef.current = {
      px,
      py,
      fx: (el.scrollLeft + px) / el.scrollWidth,
      fy: (el.scrollTop + py) / el.scrollHeight,
    };
    scaleRef.current = clamped;
    setScale(clamped);
  }

  // 拖拽平移（仅放大后生效）
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (scale <= 1 || !scrollRef.current) return;
    const el = scrollRef.current;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const s = dragStartRef.current;
    if (!s || !scrollRef.current) return;
    scrollRef.current.scrollLeft = s.left - (e.clientX - s.x);
    scrollRef.current.scrollTop = s.top - (e.clientY - s.y);
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

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
  }, [doc, slots, effectiveScale, dpr]);

  // HiDPI：窗口在 Retina / 普通屏之间拖动时 DPR 变化，更新 dpr 触发下方重渲逻辑
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(Math.min(window.devicePixelRatio || 1, 2));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dpr]);

  // Ctrl+滚轮 / 双指捏合缩放：原生非被动监听（React 合成 onWheel 无法可靠 preventDefault）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAround(
        e.clientX - rect.left,
        e.clientY - rect.top,
        scaleRef.current * Math.exp(-e.deltaY * 0.01),
      );
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      baseScaleRef.current = scaleRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEventLike;
      const rect = el.getBoundingClientRect();
      zoomAround(
        g.clientX - rect.left,
        g.clientY - rect.top,
        baseScaleRef.current * g.scale,
      );
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 缩放锚点应用：DOM 提交后按锚点校正滚动，保持光标下内容点不动
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchorRef.current;
    if (!el || !a) return;
    el.scrollLeft = a.fx * el.scrollWidth - a.px;
    el.scrollTop = a.fy * el.scrollHeight - a.py;
    zoomAnchorRef.current = null;
  }, [scale]);

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
  }, [effectiveScale, dpr]);

  async function renderPage(
    docProxy: pdfjs.PDFDocumentProxy,
    idx: number,
    s: number,
  ) {
    const container = pageRefs.current[idx];
    if (!container || container.querySelector("canvas")) return;
    const page = await docProxy.getPage(idx + 1);
    // 后备缓冲按 dpr 倍渲染：canvas 物理像素 = CSS 像素 × dpr，显示尺寸不变 → 文字锐利
    const viewport = page.getViewport({ scale: s * dpr });
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
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`min-h-0 flex-1 overflow-auto pt-2 pr-4 pb-4 ${
          scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
      >
        <div className="flex flex-col gap-3">
          {slots.map((slot, idx) => (
            <div
              key={idx}
              data-page-idx={idx}
              ref={(el) => {
                pageRefs.current[idx] = el;
              }}
              className={`mx-auto overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border transition-shadow ${
                jumpFlash === idx ? "ring-2 ring-primary" : ""
              }`}
              style={{
                width: slot.width * effectiveScale,
                aspectRatio: `${slot.width} / ${slot.height}`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
