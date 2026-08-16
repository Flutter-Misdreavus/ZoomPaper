import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  List,
  ListTree,
  Minus,
  Plus,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import {
  getAnnotations,
  saveAnnotations,
  type AnnotationRect,
  type PdfAnnotation,
} from "@/lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const SCALE_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/** 高亮色板（rgba，叠在白底页面上） */
const HIGHLIGHT_COLORS = [
  { name: "黄", color: "rgba(255,213,0,.45)" },
  { name: "绿", color: "rgba(0,200,83,.35)" },
  { name: "蓝", color: "rgba(64,156,255,.32)" },
  { name: "粉", color: "rgba(255,64,129,.32)" },
];

/** PDF 大纲节点（doc.getOutline() 返回值的子集） */
interface OutlineNode {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
}

/** 划选结果：按页分组的归一化矩形 */
interface SelGroup {
  pageIdx: number;
  rects: AnnotationRect[];
}

/** 划选后的浮动工具条状态 */
interface SelToolbar {
  x: number;
  y: number;
  text: string;
  groups: SelGroup[];
}

/** 笔记编辑弹层状态 */
interface NoteEditor {
  highlightId: string;
  draft: string;
  x: number;
  y: number;
  /** 创建模式：从划选工具条「笔记」进入时携带本次新建的高亮 id，取消时回滚删除 */
  pendingIds?: string[];
}

/**
 * 文本层宽度校正用的 item 记录：与 TextLayer.textDivs 严格一一对应
 * （仅记录 typeof str === "string" 的 item；空串 item 两者都记但 span 不挂载，
 * marked-content item 两者都跳过）。
 */
interface TextItemLog {
  str: string;
  /** PDF 空间下的字形推进宽度 */
  width: number;
  transform: number[];
  dir: string;
}

export interface PdfViewerHandle {
  /** 0-based 页码，对齐后端 page_idx */
  jumpToPage: (pageIdx: number) => void;
}

interface Props {
  pdfPath: string;
  /** 论文 id：高亮/笔记按论文持久化到 annotations.json */
  paperId: string;
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

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

/** 找到节点所属的页面容器（划选 range 的 startContainer 通常是文本 span） */
function closestPage(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  return el?.closest?.(".zp-page") ?? null;
}

/** 复制兜底：navigator.clipboard 不可用时走 execCommand */
async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 走兜底 */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/**
 * 按 canvas 字形宽度校正文本层 span。
 *
 * 根因：pdf.js 文本层 span 使用通用字体族（serif/sans-serif/monospace）渲染，
 * 而 canvas 用 PDF 内嵌字体绘制字形，两者宽度度量不同 → 选中框比真实文字宽（右缘超出）。
 * span 左缘（left%）与 canvas 线性映射一致，只需校正宽度：把 --scale-x 设为
 * (item.width × cssScale) / span 实际渲染宽度，transform-origin 0% 0% 保证左缘不动、
 * 右缘精确对齐 canvas 字形。与 pdf.js 自带 stretched-text 校正同机制。
 *
 * 用 getBoundingClientRect().width（含 scaleX / scale(min-font-size-inv) 叠加效果）作基准，
 * 天然免疫最小字号等叠加缩放；ratio 与缩放比例无关，缩放手势期间仍保持有效。
 */
function correctTextLayerWidths(
  textLayer: pdfjs.TextLayer,
  log: TextItemLog[],
  cssScale: number,
) {
  const divs = textLayer.textDivs;
  const n = Math.min(divs.length, log.length);
  for (let i = 0; i < n; i++) {
    const div = divs[i];
    if (!div.isConnected) continue;
    const item = log[i];
    if (item.dir === "rtl") continue;
    // 跳过旋转/竖排文本：角度由 item transform 的前两个元素决定
    const angle = Math.atan2(item.transform[1], item.transform[0]);
    if (Math.abs(angle) > 0.01) continue;
    const target = item.width * cssScale;
    const actual = div.getBoundingClientRect().width;
    if (actual > 0.5 && Math.abs(target - actual) > 0.5) {
      // 宽夹紧仅防病态数据；真实字体度量差异通常在 0.85–1.25 之间
      const ratio = Math.min(4, Math.max(0.25, target / actual));
      div.style.setProperty("--scale-x", String(ratio));
    }
  }
}

/** 链接/目录目标解析结果：pageIdx 0-based；yFrac 为目标点距页顶比例（0..1，无则跳页顶） */
interface DestTarget {
  pageIdx: number;
  yFrac?: number;
}

/** 仅放行 http/https 外部链接（拦截 javascript:/file:/data: 等危险协议与无 scheme 的裸串） */
function validateLinkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* 非法 URL */
  }
  return null;
}

/**
 * 解析 PDF 链接/目录目标为页码与页内位置。
 * dest 为数组直接使用，为字符串（命名目标）先 doc.getDestination 解析；
 * 目标格式 [ref, {name:'XYZ'|'FitH'|...}, x, y, zoom]。
 * 带 y 坐标的目标用目标页 viewport 换算为自顶向下比例（旋转页也正确）。
 */
async function resolveDestination(
  dest: string | unknown[],
  doc: pdfjs.PDFDocumentProxy,
): Promise<DestTarget | null> {
  try {
    const d = Array.isArray(dest) ? dest : await doc.getDestination(dest);
    if (!d || d.length === 0 || d[0] == null) return null;
    const ref = d[0];
    const pageIdx =
      typeof ref === "number"
        ? ref - 1
        : await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
    // 定位参数：d[1] 为 {name:...}，d[2..] 为坐标（PDF 空间，y 向上）
    const fit = d[1] as { name?: string } | null | undefined;
    let x: number | null | undefined;
    let y: number | null | undefined;
    if (fit?.name === "XYZ") {
      x = d[2] as number | null;
      y = d[3] as number | null;
    } else if (fit?.name === "FitH" || fit?.name === "FitBH") {
      y = d[2] as number | null;
    }
    let yFrac: number | undefined;
    if (typeof y === "number") {
      const page = await doc.getPage(pageIdx + 1);
      const vp = page.getViewport({ scale: 1 });
      const [, vy] = vp.convertToViewportPoint(typeof x === "number" ? x : 0, y);
      yFrac = Math.min(1, Math.max(0, vy / vp.height));
    }
    return { pageIdx, yFrac };
  } catch {
    return null;
  }
}

/**
 * 论文 PDF 直出：连续滚动 + 懒渲染（接近视口才 render canvas）。
 * 数据经 fetch(asset URL) → arrayBuffer 加载，避开 asset:// 协议的 range 请求兼容问题。
 *
 * 阅读体验：
 * - 每页叠 pdf.js TextLayer（透明文字）→ 原生选中/复制；
 * - 划选后浮动工具条 → 高亮（4 色）/ 笔记 / 复制；
 * - 高亮/笔记持久化到论文目录 annotations.json（归一化矩形，随缩放自动缩放）；
 * - 原生带 outline 的 PDF 显示目录侧栏，点击跳页。
 */
export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { pdfPath, paperId, initialPageIdx },
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

  // 阅读标注（高亮/笔记）
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [selToolbar, setSelToolbar] = useState<SelToolbar | null>(null);
  const [noteEditor, setNoteEditor] = useState<NoteEditor | null>(null);

  // 目录（仅原生 outline）
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [showToc, setShowToc] = useState(false);
  const [expanded, setExpanded] = useState<Set<OutlineNode>>(new Set());
  const [outlineTick, setOutlineTick] = useState(0);
  const outlinePageRef = useRef<Map<OutlineNode, number>>(new Map());
  const annotationsLoadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderedRef = useRef<Set<number>>(new Set());
  // 每页的 TextLayer 实例（缩放重建时 cancel 旧实例）
  const textLayersRef = useRef<(pdfjs.TextLayer | null)[]>([]);
  // 已构建链接层的页（链接层为百分比定位，缩放重建时无需重建）
  const linksBuiltRef = useRef<Set<number>>(new Set());
  const effectiveScale = scale * fitScale;
  // 渲染用最新 effectiveScale（懒渲染 observer 不随 scale 重建，读 ref 避免闭包过期）
  const effectiveScaleRef = useRef(effectiveScale);
  // 缩放重渲防抖定时器
  const rerenderTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    effectiveScaleRef.current = effectiveScale;
  }, [effectiveScale]);

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
    // 缩放过程中旧选区已不对齐，收起浮动工具条
    setSelToolbar(null);
  }

  // 拖拽平移（仅放大后生效；文本层/链接层上不启动，保证放大后仍可划选与点击链接）
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (scale <= 1 || !scrollRef.current) return;
    if ((e.target as HTMLElement).closest?.(".textLayer, .zp-links")) return;
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
      linksBuiltRef.current.clear();
      textLayersRef.current.forEach((tl) => tl?.cancel());
      textLayersRef.current = [];
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
        setShowToc(false);
        setShowAnnotations(false);
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

  // 读取该论文已持久化的标注
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    annotationsLoadedRef.current = false;
    getAnnotations(paperId)
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.highlights)) {
              const list = parsed.highlights.filter(
                (h: unknown): h is PdfAnnotation =>
                  !!h &&
                  typeof (h as PdfAnnotation).id === "string" &&
                  Number.isFinite((h as PdfAnnotation).page_idx) &&
                  Array.isArray((h as PdfAnnotation).rects) &&
                  (h as PdfAnnotation).rects.length > 0,
              );
              setAnnotations(list);
              return;
            }
          } catch {
            /* 解析失败视为无标注 */
          }
        }
        setAnnotations([]);
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      })
      .finally(() => {
        if (!cancelled) annotationsLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, paperId]);

  // 标注变更后防抖落盘（笔记输入防抖，增删改色即时进入该队列）
  useEffect(() => {
    if (!annotationsLoadedRef.current) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveAnnotations(
        paperId,
        JSON.stringify({ version: 1, highlights: annotations }),
      ).catch(() => {});
    }, 400);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [annotations, paperId]);

  // 读取原生目录（无 outline 则保持 null，不显示目录按钮）
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    outlinePageRef.current.clear();
    setOutline(null);
    doc
      .getOutline()
      .then((nodes) => {
        if (cancelled) return;
        const list = (nodes ?? []) as OutlineNode[];
        if (list.length) {
          setOutline(list);
          setExpanded(new Set(list.filter((n) => n.items?.length)));
        }
      })
      .catch(() => {
        if (!cancelled) setOutline(null);
      });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // 目录侧栏打开时一次性预解析所有节点页码（顺序 await + 缓存）
  useEffect(() => {
    if (!showToc || !doc || !outline) return;
    let cancelled = false;
    (async () => {
      const stack = [...outline];
      while (stack.length) {
        const node = stack.pop()!;
        if (node.items?.length) stack.push(...node.items);
        if (!node.dest || outlinePageRef.current.has(node)) continue;
        const target = await resolveDestination(node.dest, doc);
        if (!cancelled && target) {
          outlinePageRef.current.set(node, target.pageIdx);
          setOutlineTick((t) => t + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showToc, doc, outline]);

  // 选择结束（mouseup / 选区清空）移除各页文本层 selecting，恢复链接可点；
  // 选区存在期间保持链接禁用（官方行为：先点空白清除选区，再点链接）
  useEffect(() => {
    if (!doc) return;
    const clearSelecting = () => {
      for (const el of pageRefs.current) {
        el?.querySelector(".textLayer")?.classList.remove("selecting");
      }
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const textLayers = pageRefs.current
        .map((el) => el?.querySelector(".textLayer"))
        .filter((tl): tl is HTMLElement => !!tl);
      if (!sel || sel.isCollapsed) {
        for (const tl of textLayers) tl.classList.remove("selecting");
        return;
      }
      // 先全部清除，再给选区相交的页加上（避免陈旧 selecting 残留）
      for (const tl of textLayers) tl.classList.remove("selecting");
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        for (const tl of textLayers) {
          if (range.intersectsNode(tl)) tl.classList.add("selecting");
        }
      }
    };
    document.addEventListener("mouseup", clearSelecting);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", clearSelecting);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [doc]);

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
            void renderPage(doc, idx);
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
  }, [doc, slots, dpr]);

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
        scaleRef.current * Math.exp(-e.deltaY * 0.002),
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

  // 缩放/dpr 变化后「防抖」重渲：手势期间旧 canvas 先 CSS 拉伸（流畅），停止后再补锐
  useEffect(() => {
    if (!doc) return;
    rerenderTimerRef.current = window.setTimeout(() => {
      renderedRef.current.clear();
      pageRefs.current.forEach((el, idx) => {
        if (!el) return;
        const canvas = el.querySelector("canvas");
        if (canvas) canvas.remove();
        textLayersRef.current[idx]?.cancel();
        textLayersRef.current[idx] = null;
        el.querySelector(".textLayer")?.remove();
      });
      // 对可见页直接渲染
      pageRefs.current.forEach((el, idx) => {
        if (!el || !scrollRef.current) return;
        const r = el.getBoundingClientRect();
        const root = scrollRef.current.getBoundingClientRect();
        if (r.bottom > root.top - 600 && r.top < root.bottom + 600) {
          renderedRef.current.add(idx);
          void renderPage(doc, idx);
        }
      });
      rerenderTimerRef.current = null;
    }, 150);
    return () => {
      if (rerenderTimerRef.current !== null) {
        window.clearTimeout(rerenderTimerRef.current);
        rerenderTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, effectiveScale, dpr]);

  // 划选结束：把选区换算为各页归一化矩形，弹出浮动工具条
  function handleMouseUp(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelToolbar(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      setSelToolbar(null);
      return;
    }
    const groups: SelGroup[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const pageEl = closestPage(range.startContainer);
      if (!pageEl) continue;
      const pageIdx = Number(pageEl.dataset.pageIdx);
      if (!Number.isFinite(pageIdx)) continue;
      const pr = pageEl.getBoundingClientRect();
      if (pr.width === 0 || pr.height === 0) continue;
      const rects: AnnotationRect[] = [];
      for (const r of Array.from(range.getClientRects())) {
        const x = clamp01((r.left - pr.left) / pr.width);
        const y = clamp01((r.top - pr.top) / pr.height);
        const x2 = clamp01((r.right - pr.left) / pr.width);
        const y2 = clamp01((r.bottom - pr.top) / pr.height);
        if (x2 - x > 0.0005 && y2 - y > 0.0005) {
          rects.push({ x, y, w: x2 - x, h: y2 - y });
        }
      }
      if (rects.length) groups.push({ pageIdx, rects });
    }
    if (!groups.length) {
      setSelToolbar(null);
      return;
    }
    const last = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect();
    setSelToolbar({
      x: Math.min(last.left, window.innerWidth - 320),
      y: last.bottom + 8,
      text,
      groups,
    });
  }

  // 建高亮（openNote 时同时打开笔记编辑）
  function createHighlights(color: string, openNote = false) {
    if (!selToolbar) return;
    const now = Date.now();
    const created: PdfAnnotation[] = selToolbar.groups.map((g) => ({
      id: crypto.randomUUID(),
      page_idx: g.pageIdx,
      rects: g.rects,
      color,
      text: selToolbar.text.slice(0, 500),
      note: null,
      created_at: now,
    }));
    setAnnotations((prev) => [...prev, ...created]);
    const pos = { x: selToolbar.x, y: selToolbar.y };
    setSelToolbar(null);
    // 清除浏览器原生选区，只保留我们绘制的高亮
    window.getSelection()?.removeAllRanges();
    if (openNote && created.length) {
      setNoteEditor({
        highlightId: created[0].id,
        draft: "",
        x: pos.x,
        y: pos.y + 44,
        pendingIds: created.map((a) => a.id),
      });
    }
  }

  async function copySelection() {
    if (!selToolbar) return;
    await copyTextToClipboard(selToolbar.text);
    setSelToolbar(null);
  }

  function saveNote() {
    if (!noteEditor) return;
    const text = noteEditor.draft.trim();
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === noteEditor.highlightId
          ? { ...a, note: text ? { text, updated_at: Date.now() } : null }
          : a,
      ),
    );
    setNoteEditor(null);
  }

  /** 关闭笔记弹层；创建模式（带 pendingIds）下取消即回滚本次新建的高亮 */
  function closeNoteEditor() {
    if (noteEditor?.pendingIds?.length) {
      const pending = new Set(noteEditor.pendingIds);
      setAnnotations((prev) => prev.filter((a) => !pending.has(a.id)));
    }
    setNoteEditor(null);
  }

  function deleteHighlight(id: string) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }

  function startEditNote(hl: PdfAnnotation) {
    setNoteEditor({
      highlightId: hl.id,
      draft: hl.note?.text ?? "",
      x: Math.max(16, window.innerWidth / 2 - 160),
      y: 120,
    });
  }

  // Esc 关闭浮动层（创建中的笔记一并回滚）
  useEffect(() => {
    if (!selToolbar && !noteEditor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelToolbar(null);
        closeNoteEditor();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selToolbar, noteEditor]);

  // 目录节点点击：跳页或打开外链
  async function onOutlineClick(node: OutlineNode) {
    if (node.url) {
      void openUrl(node.url).catch(() => {});
      return;
    }
    if (!node.dest || !doc) return;
    const cached = outlinePageRef.current.get(node);
    if (cached != null) {
      jumpToPage(cached);
      return;
    }
    const target = await resolveDestination(node.dest, doc);
    if (target) {
      outlinePageRef.current.set(node, target.pageIdx);
      setOutlineTick((t) => t + 1);
      jumpToPage(target.pageIdx);
    }
  }

  function toggleExpand(node: OutlineNode) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  }

  function renderOutlineNodes(nodes: OutlineNode[], depth: number) {
    return nodes.map((node, i) => (
      <div key={i}>
        <button
          className={`group flex w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left text-[13px] hover:bg-accent ${
            node.bold ? "font-semibold" : ""
          } ${node.italic ? "italic" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => void onOutlineClick(node)}
          title={node.title}
        >
          {node.items?.length ? (
            expanded.has(node) ? (
              <ChevronDown
                className="h-3 w-3 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node);
                }}
              />
            ) : (
              <ChevronRight
                className="h-3 w-3 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node);
                }}
              />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          {outlinePageRef.current.has(node) && (
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {outlinePageRef.current.get(node)! + 1}
            </span>
          )}
        </button>
        {/* 注意：必须用 length > 0 得到布尔值——`0 && x` 会被 React 渲染成文本 "0" */}
        {node.items?.length > 0 && expanded.has(node) && (
          <div>{renderOutlineNodes(node.items, depth + 1)}</div>
        )}
      </div>
    ));
  }

  async function renderPage(
    docProxy: pdfjs.PDFDocumentProxy,
    idx: number,
  ) {
    const container = pageRefs.current[idx];
    if (!container || container.querySelector("canvas")) return;
    try {
      const page = await docProxy.getPage(idx + 1);
      // 后备缓冲按 dpr 倍渲染：canvas 物理像素 = CSS 像素 × dpr，显示尺寸不变 → 文字锐利
      const viewport = page.getViewport({ scale: effectiveScaleRef.current * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = "block h-auto w-full";
      container.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // 文本层：CSS 比例（不乘 dpr），与 canvas 并行渲染。
      // 包装 textContentSource 以按序记录每个文本 item（与 textDivs 一一对应），
      // 渲染完成后做宽度校正，解决通用字体族与内嵌字体的宽度度量差异。
      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";
      container.appendChild(textDiv);
      // 官方 selecting 机制：从文本层按下进入选择模式 → 链接层临时失效（可划选穿越链接）
      textDiv.addEventListener("mousedown", () => {
        textDiv.classList.add("selecting");
      });
      const itemLog: TextItemLog[] = [];
      const wrappedStream = new ReadableStream({
        async start(controller) {
          const reader = page.streamTextContent().getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              if (value?.items) {
                for (const it of value.items) {
                  if (typeof it.str === "string") {
                    itemLog.push({
                      str: it.str,
                      width: it.width,
                      transform: it.transform,
                      dir: it.dir,
                    });
                  }
                }
              }
              controller.enqueue(value);
            }
          } catch (e) {
            controller.error(e);
          }
        },
      });
      const textLayer = new pdfjs.TextLayer({
        textContentSource: wrappedStream,
        container: textDiv,
        viewport: page.getViewport({ scale: effectiveScaleRef.current }),
      });
      textLayersRef.current[idx] = textLayer;
      const textLayerTask = textLayer
        .render()
        .then(() => {
          correctTextLayerWidths(textLayer, itemLog, effectiveScaleRef.current);
        })
        .catch(() => {
          /* 文档销毁/缩放取消时静默忽略 */
        });
      // 链接层：每页仅构建一次（百分比定位，缩放重建时无需重建）
      const linksTask = buildLinksLayer(page, idx).catch(() => {});
      await Promise.all([page.render({ canvas, canvasContext: ctx, viewport }).promise, textLayerTask, linksTask]);
    } catch {
      /* 文档销毁/缩放取消时静默忽略 */
    }
  }

  function jumpToPage(pageIdx: number) {
    const el = pageRefs.current[pageIdx];
    if (!el || !scrollRef.current) return;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    setCurrentPage(pageIdx + 1);
    setJumpFlash(pageIdx);
    window.setTimeout(() => setJumpFlash(null), 1200);
  }

  /** 跳转到目标：有 yFrac 时精确滚动到页内位置，否则跳页顶 */
  function jumpToDest(target: DestTarget) {
    const scroller = scrollRef.current;
    const el = pageRefs.current[target.pageIdx];
    const slot = slots[target.pageIdx];
    if (!scroller || !el || !slot || target.yFrac == null) {
      jumpToPage(target.pageIdx);
      return;
    }
    const pageTop =
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const targetTop = pageTop + target.yFrac * slot.height * effectiveScale;
    scroller.scrollTo({ top: targetTop, behavior: "smooth" });
    setCurrentPage(target.pageIdx + 1);
    setJumpFlash(target.pageIdx);
    window.setTimeout(() => setJumpFlash(null), 1200);
  }

  /** 链接点击：外链放行 http/https 打开系统浏览器；内部 dest 解析后精确跳转 */
  async function handleLinkClick(annotation: unknown) {
    const a = annotation as {
      url?: string | null;
      unsafeUrl?: string | null;
      dest?: string | unknown[] | null;
    };
    if (a.url || a.unsafeUrl) {
      const url = validateLinkUrl(a.url ?? a.unsafeUrl);
      if (url) void openUrl(url).catch(() => {});
      return;
    }
    if (a.dest && doc) {
      const target = await resolveDestination(a.dest, doc);
      if (target) jumpToDest(target);
    }
  }

  /** 构建某页的链接层（百分比定位，缩放自动缩放；每页仅一次） */
  async function buildLinksLayer(page: pdfjs.PDFPageProxy, idx: number) {
    const container = pageRefs.current[idx];
    if (!container || linksBuiltRef.current.has(idx)) return;
    linksBuiltRef.current.add(idx);
    let annotations: Array<{
      annotationType?: number;
      rect?: number[];
      url?: string | null;
      unsafeUrl?: string | null;
      dest?: string | unknown[] | null;
    }> = [];
    try {
      annotations = await page.getAnnotations({ intent: "display" });
    } catch {
      return;
    }
    const links = annotations.filter(
      (a) =>
        a.annotationType === pdfjs.AnnotationType.LINK &&
        (a.url || a.unsafeUrl || a.dest) &&
        Array.isArray(a.rect) &&
        a.rect.length === 4,
    );
    if (!links.length) return;
    const viewport = page.getViewport({ scale: 1 });
    const W = viewport.width;
    const H = viewport.height;
    const layer = document.createElement("div");
    layer.className = "zp-links";
    for (const link of links) {
      const rect = link.rect!;
      const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
      const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
      const left = clamp01(Math.min(x1, x2) / W);
      const top = clamp01(Math.min(y1, y2) / H);
      const right = clamp01(Math.max(x1, x2) / W);
      const bottom = clamp01(Math.max(y1, y2) / H);
      if (right - left <= 0.0005 || bottom - top <= 0.0005) continue;
      const el = document.createElement("a");
      el.className = "zp-link";
      el.style.left = `${left * 100}%`;
      el.style.top = `${top * 100}%`;
      el.style.width = `${(right - left) * 100}%`;
      el.style.height = `${(bottom - top) * 100}%`;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void handleLinkClick(link);
      });
      layer.appendChild(el);
    }
    if (layer.childElementCount) container.appendChild(layer);
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

  // 按页分组高亮（供 overlay 渲染）
  const highlightsByPage = new Map<number, PdfAnnotation[]>();
  for (const hl of annotations) {
    const list = highlightsByPage.get(hl.page_idx);
    if (list) list.push(hl);
    else highlightsByPage.set(hl.page_idx, [hl]);
  }
  const sortedAnnotations = [...annotations].sort(
    (a, b) => a.page_idx - b.page_idx || a.created_at - b.created_at,
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 pt-2 pr-4">
        <div className="mr-auto flex items-center gap-1 pl-4">
          {outline && outline.length > 0 && (
            <Button
              variant={showToc ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowToc((v) => !v)}
              title="目录"
            >
              <ListTree className="h-3.5 w-3.5" />
              <span className="ml-1 hidden sm:inline">目录</span>
            </Button>
          )}
          <Button
            variant={showAnnotations ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setShowAnnotations((v) => !v)}
            title="注释"
          >
            <List className="h-3.5 w-3.5" />
            <span className="ml-1 hidden sm:inline">
              注释{annotations.length ? ` ${annotations.length}` : ""}
            </span>
          </Button>
        </div>
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
        onMouseUp={handleMouseUp}
        onScroll={() => setSelToolbar(null)}
        className={`min-h-0 flex-1 overflow-auto pt-2 pr-4 pb-4 ${
          scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
      >
        <div className="flex flex-col gap-3">
          {slots.map((slot, idx) => {
            const pageHighlights = highlightsByPage.get(idx);
            return (
              <div
                key={idx}
                data-page-idx={idx}
                ref={(el) => {
                  pageRefs.current[idx] = el;
                }}
                className={`zp-page relative mx-auto overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border transition-shadow ${
                  jumpFlash === idx ? "ring-2 ring-primary" : ""
                }`}
                style={
                  {
                    width: slot.width * effectiveScale,
                    aspectRatio: `${slot.width} / ${slot.height}`,
                    // pdf.js 文本层契约：尺寸/字号按该变量实时缩放（随 canvas CSS 拉伸对齐）
                    "--total-scale-factor": effectiveScale,
                    "--scale-round-x": "0.01px",
                    "--scale-round-y": "0.01px",
                  } as React.CSSProperties
                }
              >
                {pageHighlights?.length ? (
                  <div className="zp-highlights">
                    {pageHighlights.map((hl) =>
                      hl.rects.map((r, i) => (
                        <div
                          key={`${hl.id}-${i}`}
                          className="rounded-[2px]"
                          style={{
                            position: "absolute",
                            left: `${r.x * 100}%`,
                            top: `${r.y * 100}%`,
                            width: `${r.w * 100}%`,
                            height: `${r.h * 100}%`,
                            background: hl.color,
                          }}
                        />
                      )),
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* 划选浮动工具条 */}
      {selToolbar && (
        <div
          className="fixed z-50 flex items-center gap-1 rounded-lg border bg-popover px-1.5 py-1 shadow-lg select-none"
          style={{ left: selToolbar.x, top: selToolbar.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.name}
              title={`高亮：${c.name}`}
              className="h-5 w-5 rounded-full ring-1 ring-black/15 transition-transform hover:scale-110"
              style={{ background: c.color }}
              onClick={() => createHighlights(c.color)}
            />
          ))}
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => createHighlights(HIGHLIGHT_COLORS[0].color, true)}
          >
            <StickyNote className="h-3 w-3" />
            笔记
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => void copySelection()}
          >
            <Copy className="h-3 w-3" />
            复制
          </Button>
        </div>
      )}

      {/* 笔记编辑弹层 */}
      {noteEditor && (
        <div
          className="fixed z-50 w-72 rounded-lg border bg-popover p-3 shadow-lg"
          style={{
            left: Math.max(8, Math.min(noteEditor.x, window.innerWidth - 300)),
            top: Math.max(8, noteEditor.y),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Textarea
            autoFocus
            value={noteEditor.draft}
            onChange={(e) =>
              setNoteEditor({ ...noteEditor, draft: e.target.value })
            }
            placeholder="写下你的笔记…"
            className="min-h-20 text-sm"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={closeNoteEditor}
            >
              取消
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={saveNote}>
              <Check className="h-3 w-3" />
              保存
            </Button>
          </div>
        </div>
      )}

      {/* 目录侧栏（仅原生 outline） */}
      {showToc && outline && outline.length > 0 && (
        <div className="absolute inset-y-0 left-0 z-20 flex w-60 flex-col border-r bg-background/95 backdrop-blur">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-semibold">目录</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowToc(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div
            key={outlineTick}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          >
            {renderOutlineNodes(outline, 0)}
          </div>
        </div>
      )}

      {/* 注释列表面板 */}
      {showAnnotations && (
        <div className="absolute inset-y-0 right-0 z-20 flex w-72 flex-col border-l bg-background/95 backdrop-blur">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-semibold">
              注释（{annotations.length}）
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowAnnotations(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {sortedAnnotations.length === 0 && (
              <p className="px-1 text-xs text-muted-foreground">
                暂无高亮/笔记。划选文字后点「高亮」即可添加。
              </p>
            )}
            {sortedAnnotations.map((hl) => (
              <div
                key={hl.id}
                className="group mb-1.5 cursor-pointer rounded-lg border p-2 hover:bg-accent/60"
                onClick={() => {
                  jumpToPage(hl.page_idx);
                  setJumpFlash(hl.page_idx);
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: hl.color }}
                  />
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    第 {hl.page_idx + 1} 页
                  </span>
                  <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      title="编辑笔记"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditNote(hl);
                      }}
                    >
                      <StickyNote className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-destructive"
                      title="删除高亮"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteHighlight(hl.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-snug text-foreground/85">
                  {hl.text}
                </p>
                {hl.note && (
                  <p className="mt-1 line-clamp-2 border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground italic">
                    {hl.note.text}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
