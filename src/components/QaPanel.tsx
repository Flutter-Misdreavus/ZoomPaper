import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { QaChat } from "@/components/QaChat";
import type { AnnotationRect } from "@/lib/api";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

const WIDTH_KEY = "zoompaper.qaWidth";
const COLLAPSED_KEY = "zoompaper.qaCollapsed";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
/** 左列（原文/博客）最小可读宽度，拖拽上限 = 行容器宽 − 该值 */
const LEFT_MIN_WIDTH = 320;
const COLLAPSED_WIDTH = 40;

function loadWidth(): number {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
}

/** PDF 选中段落（上下文引用条目；rects 为归一化矩形，用于「跳转到原文」精确定位） */
export interface AskSelection {
  text: string;
  /** 0-based 页码；博客/译文划选为 null */
  pageIdx: number | null;
  rects?: AnnotationRect[];
  /** 人类可读来源位置（博客/译文划选：如「博客·洞见」；PDF 划选不传） */
  location?: string;
}

export interface QaPanelHandle {
  /** 接收 PDF/博客/译文选中的段落：展开面板并把该段追加到上下文引用区（去重、有上限） */
  acceptSelection: (
    text: string,
    pageIdx: number | null,
    rects?: AnnotationRect[],
    location?: string,
  ) => void;
}

interface Props {
  paperId: string;
  /** 引用点击后 PDF 内跳页（0-based） */
  onJumpPage?: (pageIdx: number) => void;
  /** 引用区「跳转到原文」：跳回 PDF 选中段落所在位置 */
  onJumpToSelection?: (pageIdx: number, rects?: AnnotationRect[]) => void;
}

/** 上下文引用条数上限 */
const MAX_SELECTIONS = 5;

/**
 * 阅读页右侧问答栏：可拖拽左缘分隔条调宽（1:1 跟踪，拖拽中无过渡），
 * 可收纳为 40px 竖条（宽度过渡 240ms ease-drawer）。
 * QaChat 始终挂载（display:none 隐藏），收纳不丢会话状态。
 * 注：费曼学习法已提升为左列独立视图（Reader 的 Tabs），此处仅保留普通问答。
 */
export const QaPanel = forwardRef<QaPanelHandle, Props>(function QaPanel(
  { paperId, onJumpPage, onJumpToSelection },
  ref,
) {
  const [width, setWidth] = useState(loadWidth);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  const [dragging, setDragging] = useState(false);
  // PDF 选中的段落列表（上下文引用区，可多条；发送成功后由 QaChat 回调清空）
  const [selections, setSelections] = useState<AskSelection[]>([]);
  const dragStart = useRef<{ x: number; width: number; max: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    acceptSelection(
      text: string,
      pageIdx: number | null,
      rects?: AnnotationRect[],
      location?: string,
    ) {
      setCollapsed(false);
      setSelections((prev) => {
        // 同页同文本去重；达到上限后忽略
        if (prev.some((s) => s.text === text && s.pageIdx === pageIdx)) return prev;
        if (prev.length >= MAX_SELECTIONS) return prev;
        return [...prev, { text, pageIdx, rects, location }];
      });
    },
  }));

  // 当前允许的最大宽度：行容器宽 − 左列最小宽 − 分隔条宽，且不超过 MAX_WIDTH
  function currentMaxWidth(): number {
    const row = rootRef.current?.parentElement;
    if (!row) return MAX_WIDTH;
    return Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, row.getBoundingClientRect().width - LEFT_MIN_WIDTH - 8),
    );
  }

  function toggleCollapsed(next: boolean) {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragStart.current = { x: e.clientX, width, max: currentMaxWidth() };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) return;
    // 分隔条在面板左缘：指针左移 = 面板变宽
    const next = Math.min(
      start.max,
      Math.max(MIN_WIDTH, start.width + (start.x - e.clientX)),
    );
    setWidth(next);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    dragStart.current = null;
    setDragging(false);
    localStorage.setItem(WIDTH_KEY, String(width));
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // 挂载时若持久化宽度超出当前可用空间，收敛到动态上限
  useEffect(() => {
    setWidth((w) => Math.min(w, currentMaxWidth()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={rootRef} className="flex min-h-0 shrink-0">
      {/* 分隔条：8px hit 区，hover/拖拽显示指示线；收纳时隐藏 */}
      {!collapsed && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="group relative w-2 shrink-0 cursor-col-resize touch-none"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整问答栏宽度"
        >
          <div
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
              dragging ? "bg-primary/60" : "bg-border group-hover:bg-primary/40"
            }`}
          />
        </div>
      )}

      <aside
        className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border bg-card"
        style={{
          width: collapsed ? COLLAPSED_WIDTH : width,
          marginLeft: collapsed ? 8 : 0,
          transition: dragging
            ? "none"
            : "width 240ms var(--ease-drawer), margin-left 240ms var(--ease-drawer)",
        }}
      >
        {/* 收纳态：整根竖条可点击展开 */}
        <button
          onClick={() => toggleCollapsed(false)}
          title="展开对话"
          className={`flex-col items-center gap-2 py-3 text-muted-foreground transition-colors hover:text-foreground ${
            collapsed ? "flex flex-1" : "hidden"
          }`}
        >
          <PanelRightOpen className="h-4 w-4" />
          <span className="text-xs [writing-mode:vertical-rl]">对话</span>
        </button>

        {/* 展开态：display:none 保持挂载，不丢会话状态 */}
        <div className={`min-h-0 flex-1 flex-col ${collapsed ? "hidden" : "flex"}`}>
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="px-1 text-xs font-medium text-muted-foreground">问答</span>
            <button
              onClick={() => toggleCollapsed(true)}
              title="收起对话"
              className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <QaChat
              paperId={paperId}
              onJumpPage={onJumpPage}
              onJumpToSelection={onJumpToSelection}
              selections={selections}
              maxSelections={MAX_SELECTIONS}
              onClearSelections={() => setSelections([])}
              onRemoveSelection={(i) =>
                setSelections((prev) => prev.filter((_, idx) => idx !== i))
              }
            />
          </div>
        </div>
      </aside>
    </div>
  );
});
