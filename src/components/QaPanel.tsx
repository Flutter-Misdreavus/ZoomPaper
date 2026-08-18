import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { QaChat } from "@/components/QaChat";
import { ConversationDeleteDialog } from "@/components/ConversationDeleteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { deleteConversation, listConversations, type Conversation } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import type { AnnotationRect } from "@/lib/api";
import { History, PanelRightClose, PanelRightOpen, Plus, Trash2 } from "lucide-react";

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

/** 每篇论文「上次打开的会话」localStorage key */
function lastConvKey(paperId: string): string {
  return `zoompaper.lastConv.${paperId}`;
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
 * 头部「历史会话」下拉：当前论文的历史会话选择 / 新对话 / 删除（带确认）；
 * 用 localStorage 记住每篇论文上次打开的会话，重新进入自动恢复。
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

  // ---- 历史会话 ----
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /** null = 新会话 */
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** 待删除确认的会话 */
  const [confirmDelete, setConfirmDelete] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** QaChat 上报的发送状态（生成中禁用会话切换） */
  const [sending, setSending] = useState(false);

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

  // 会话列表刷新（创建/删除后调用；保持当前激活会话不变）
  const refresh = useCallback(async () => {
    try {
      const all = await listConversations();
      // 仅展示当前论文的会话
      setConversations(all.filter((c) => c.paper_id === paperId));
    } catch (e) {
      setHistoryError(String(e));
    }
  }, [paperId]);

  // 论文切换/挂载：重置为新会话并加载该论文历史，尝试恢复上次打开的会话
  useEffect(() => {
    let cancelled = false;
    setActiveConvId(null);
    setSelections([]);
    setHistoryOpen(false);
    setHistoryLoading(true);
    setHistoryError(null);
    (async () => {
      try {
        const all = await listConversations();
        if (cancelled) return;
        const mine = all.filter((c) => c.paper_id === paperId);
        setConversations(mine);
        // 恢复上次打开的会话（已被删除则清掉陈旧 key）
        const saved = localStorage.getItem(lastConvKey(paperId));
        if (saved && mine.some((c) => c.id === saved)) {
          setActiveConvId(saved);
        } else if (saved) {
          localStorage.removeItem(lastConvKey(paperId));
        }
      } catch (e) {
        if (!cancelled) setHistoryError(String(e));
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  /** 新会话创建成功：设为当前并记住（供下次进入恢复） */
  function handleConversationCreated(id: string) {
    setActiveConvId(id);
    localStorage.setItem(lastConvKey(paperId), id);
    void refresh();
  }

  /** 选择历史会话（生成中禁用；切换时清空引用区——旧线程的上下文） */
  function selectConversation(id: string) {
    if (sending) return;
    setActiveConvId(id);
    localStorage.setItem(lastConvKey(paperId), id);
    setSelections([]);
    setHistoryOpen(false);
  }

  /** 开启新对话（生成中禁用；清空引用区） */
  function startNew() {
    if (sending) return;
    setActiveConvId(null);
    localStorage.removeItem(lastConvKey(paperId));
    setSelections([]);
    setHistoryOpen(false);
  }

  /** 确认删除：删除会话；若删的是当前会话则回到新对话 */
  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteConversation(confirmDelete.id);
      if (activeConvId === confirmDelete.id) {
        setActiveConvId(null);
        localStorage.removeItem(lastConvKey(paperId));
      }
      setConfirmDelete(null);
      void refresh();
    } catch (e) {
      setHistoryError(String(e));
    } finally {
      setDeleting(false);
    }
  }

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
            <div className="flex items-center gap-0.5">
              {/* 历史会话下拉：新对话 / 当前论文历史会话选择 / 删除 */}
              <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
                <PopoverTrigger
                  disabled={sending}
                  title={sending ? "生成中不可切换会话" : "历史会话"}
                  className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <History className="h-4 w-4" />
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={4} className="w-64 p-1">
                  <button
                    onClick={startNew}
                    disabled={sending}
                    className="pressable flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-primary transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新对话
                  </button>
                  <Separator className="my-1" />
                  {historyError && (
                    <p className="px-2 py-1 text-[11px] text-destructive">{historyError}</p>
                  )}
                  {historyLoading ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">加载会话…</p>
                  ) : conversations.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">
                      暂无历史会话
                    </p>
                  ) : (
                    <div className="max-h-72 overflow-y-auto">
                      {conversations.map((c) => (
                        <div key={c.id} className="group relative">
                          <button
                            onClick={() => selectConversation(c.id)}
                            className={`block w-full rounded-md px-2 py-1.5 pr-7 text-left transition-colors ${
                              activeConvId === c.id
                                ? "bg-accent text-accent-foreground"
                                : "text-foreground/85 hover:bg-accent/50"
                            }`}
                          >
                            <div className="truncate text-[13px] font-medium">
                              {c.title || "未命名会话"}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {formatTime(c.updated_at)}
                            </div>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(c);
                            }}
                            title="删除会话"
                            className="pressable absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <button
                onClick={() => toggleCollapsed(true)}
                title="收起对话"
                className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelRightClose className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <QaChat
              key={activeConvId ?? "new"}
              paperId={paperId}
              conversationId={activeConvId}
              onJumpPage={onJumpPage}
              onJumpToSelection={onJumpToSelection}
              selections={selections}
              maxSelections={MAX_SELECTIONS}
              onClearSelections={() => setSelections([])}
              onRemoveSelection={(i) =>
                setSelections((prev) => prev.filter((_, idx) => idx !== i))
              }
              onConversationCreated={handleConversationCreated}
              onSendingChange={setSending}
            />
          </div>
        </div>
      </aside>

      {/* 删除会话确认弹窗 */}
      <ConversationDeleteDialog
        conversation={confirmDelete}
        deleting={deleting}
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
});
