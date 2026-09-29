/**
 * 论文卡片（PaperCard）：状态驱动极简卡片。
 * 结构：状态圆点 + 标题(2行截断) + 期刊/会议 + 解析状态 + 星标 + 更多。
 * 长按进入多选模式后显示复选框；双击打开论文。
 */
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useMemo, useRef, useState } from "react";
import { CalendarClock, Check, MoreHorizontal, Star } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn, displayPaperTitle, parseProgressPercent } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import { PAPER_DRAG_MIME } from "@/lib/folders";
import type { Folder, Paper, ParseProgress, ReadingPlan, ReadingStatus } from "@/lib/api";
import { PaperMenuItems, type PaperMenuActions } from "./paperMenu";
import {
  PlanSubmenu,
  dueBadge,
  type PlanMenuPrimitives,
} from "./planMenu";
import { RenameInput } from "./RenameInput";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { useLongPressSelection } from "@/hooks/useLongPressSelection";
import { VenueBadge } from "./VenueBadge";

/** 解析状态作为次要元信息显示；失败时保留警示色。 */
const PARSE_STYLE: Record<string, { label: string; className: string }> = {
  ready: { label: "已解析", className: "text-zp-quaternary" },
  parsing: { label: "解析中…", className: "text-zp-secondary" },
  unparsed: { label: "未解析", className: "text-zp-quaternary" },
  failed: { label: "解析失败", className: "text-red-600 dark:text-red-400" },
};

function readingStatusOf(s: string): ReadingStatus {
  return s === "unread" || s === "reading" || s === "read" ? s : "unread";
}

export interface PaperCardProps {
  paper: Paper;
  /** 全部文件夹（用于解析归属色点与名称） */
  folders: Folder[];
  selected: boolean;
  selectedIds: ReadonlySet<string>;
  /** 选择模式中显示复选框 */
  selectionMode: boolean;
  onLongPress: (paperId: string) => void;
  isRenaming: boolean;
  parsing: boolean;
  progress?: ParseProgress | null;
  /** 当前处于某文件夹视图时的 folderId；null = 全部/未分类视图 */
  currentFolderId: string | null;
  onToggle: (paperId: string) => void;
  onSelectionDragStart: (paperId: string, selected: boolean) => void;
  onSelectionDragEnter: (paperId: string) => void;
  onOpen: (paperId: string) => void;
  onStartRename: (paper: Paper) => void;
  onCommitRename: (paper: Paper, title: string) => void;
  onCancelRename: () => void;
  /** 打开归属面板；未选中该论文时以它为目标 */
  onPickFolder: (paper: Paper) => void;
  onSetStatus: (paper: Paper, status: ReadingStatus) => void;
  onBulkSetStatus: (status: ReadingStatus) => void;
  onBulkDelete: () => void;
  /** 全部阅读计划（卡片据此计算所在计划与目标计划） */
  plans: ReadingPlan[];
  /** 快捷加入/更新日期：planId 为 null 时由 Library 自动新建计划 */
  onPlanQuickAdd: (paper: Paper, planId: string | null, dueTs: number | null) => void;
  onPlanRemove: (paper: Paper, planId: string) => void;
  /** 打开自定义日期浮层（Library 层） */
  onPlanCustomDate: (paper: Paper, planId: string | null) => void;
  onToggleStar: (paper: Paper) => void;
  /** 点击文件夹 pill 跳转到对应文件夹视图 */
  onJumpToFolder: (folderId: string) => void;
  onParse: (paperId: string) => void;
  onDelete: (paper: Paper) => void;
  onRemoveFromCurrentFolder: (paper: Paper) => void;
}

export function PaperCard(props: PaperCardProps) {
  const {
    paper,
    folders,
    selected,
    selectedIds,
    selectionMode,
    onLongPress,
    isRenaming,
    parsing,
    progress,
    currentFolderId,
    onToggle,
    onSelectionDragStart,
    onSelectionDragEnter,
    onOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onPickFolder,
    onSetStatus,
    onBulkSetStatus,
    onBulkDelete,
    plans,
    onPlanQuickAdd,
    onPlanRemove,
    onPlanCustomDate,
    onToggleStar,
    onJumpToFolder,
    onParse,
    onDelete,
    onRemoveFromCurrentFolder,
  } = props;

  const st = PARSE_STYLE[paper.parse_status] ?? PARSE_STYLE.unparsed;
  const percentRef = useRef(0);
  if (!progress) percentRef.current = 0;
  else percentRef.current = Math.max(percentRef.current, parseProgressPercent(progress));
  const status = readingStatusOf(paper.reading_status);
  const reduceMotion = useReducedMotion();
  const longPress = useLongPressSelection((paperId) => {
    onLongPress(paperId);
    onSelectionDragStart(paperId, selected);
  });
  // 归属文件夹（多归属；按 id 解析，脏数据过滤）
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const paperFolders = paper.folder_ids
    .map((id) => folderById.get(id))
    .filter((f): f is Folder => Boolean(f));

  const useBulkActions = selectionMode && selected;
  const menuActions: PaperMenuActions = {
    onOpen: () => onOpen(paper.id),
    onRename: () => onStartRename(paper),
    onPickFolder: () => onPickFolder(paper),
    onRemoveFromCurrentFolder: currentFolderId
      ? () => onRemoveFromCurrentFolder(paper)
      : undefined,
    onSetStatus: (s) => useBulkActions ? onBulkSetStatus(s) : onSetStatus(paper, s),
    currentStatus: status,
    onDelete: () => useBulkActions ? onBulkDelete() : onDelete(paper),
  };

  // ---------- 阅读计划子菜单（提醒事项式快捷定日期） ----------
  const papersPlans = plans.filter((p) => p.type === "papers");
  const activePapersPlans = papersPlans.filter((p) => p.active);
  const containingPlan =
    papersPlans.find((p) => p.items.some((i) => i.paper_id === paper.id)) ?? null;
  const currentDue =
    containingPlan?.items.find((i) => i.paper_id === paper.id)?.due_date ?? null;
  const [targetPlanId, setTargetPlanId] = useState<string | null>(null);
  // 目标计划：已加入的 > 手动选择的 > 最新的进行中计划
  const effectiveTarget =
    containingPlan ??
    activePapersPlans.find((p) => p.id === targetPlanId) ??
    activePapersPlans[0] ??
    null;

  const renderPlanSubmenu = (P: PlanMenuPrimitives) => (
    <PlanSubmenu
      P={P}
      activePlans={activePapersPlans}
      containingPlan={containingPlan}
      currentDue={currentDue}
      targetPlanId={effectiveTarget?.id ?? null}
      onSelectTarget={setTargetPlanId}
      onQuickDate={(due) => onPlanQuickAdd(paper, effectiveTarget?.id ?? null, due)}
      onCustomDate={() => onPlanCustomDate(paper, effectiveTarget?.id ?? null)}
      onRemove={
        containingPlan ? () => onPlanRemove(paper, containingPlan.id) : null
      }
    />
  );

  // 卡片 footer 的截止日期 pill（未读完且在计划中带日期时）
  const duePill =
    status !== "read" && currentDue != null ? dueBadge(currentDue, false) : null;

  function handleDragStart(e: React.DragEvent) {
    longPress.cancel();
    const ids = selected ? [...selectedIds] : [paper.id];
    if (!selected) onLongPress(paper.id);
    e.dataTransfer.setData(PAPER_DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger
        render={
          <motion.div
            initial={{ opacity: 0, ...(reduceMotion ? {} : { transform: "translateY(8px)" }) }}
            animate={{ opacity: 1, ...(reduceMotion ? {} : { transform: "translateY(0)" }) }}
            transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
          >
            <div
              draggable
              {...longPress.bind(paper.id)}
              onContextMenu={(event) => { if (longPress.suppressContextMenu(paper.id)) event.preventDefault(); }}
              onDragStart={handleDragStart}
              tabIndex={0}
              role="button"
              data-paper-item
              aria-label={paper.title}
              onClick={(event) => {
                if (longPress.consumeClick(paper.id)) { event.preventDefault(); event.stopPropagation(); return; }
                if (selectionMode) onToggle(paper.id);
              }}
              onDoubleClick={() => { if (!selectionMode) onOpen(paper.id); }}
              onPointerEnter={() => { if (selectionMode) onSelectionDragEnter(paper.id); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (selectionMode) onToggle(paper.id);
                  else onOpen(paper.id);
                } else if (e.key === " " && !e.repeat) {
                  e.preventDefault();
                  if (selectionMode) onToggle(paper.id);
                  else onLongPress(paper.id);
                }
              }}
              className={cn(
                "group relative flex cursor-default flex-col gap-1 rounded-[10px] border bg-white p-4 outline-none transition-all select-none",
                "dark:bg-zp-surface",
                selected
                  ? "border-zp-primary shadow-[0_0_0_1px] shadow-zp-primary"
                  : "border-zp-border hover:border-[#d4d4d4] hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              {/* header：复选框 + 状态圆点 + 标题 + 星标/更多 */}
              <div className="flex items-start gap-2">
                {selectionMode && <button
                  type="button"
                  aria-label={selected ? "取消选择" : "选择"}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !e.isPrimary) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectionDragStart(paper.id, selected);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.detail === 0) onToggle(paper.id);
                  }}
                  className={cn(
                    "mt-0.5 flex h-[18px] w-[18px] touch-none shrink-0 items-center justify-center rounded-[5px] border transition-all",
                    selected
                      ? "border-zp-primary bg-zp-primary text-white opacity-100"
                      : "border-zp-border bg-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 dark:bg-zp-surface",
                    "opacity-100"
                  )}
                >
                  {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                </button>}

                <VenueBadge venue={paper.venue} sourceUrl={paper.source_url} iconUrl={paper.source_icon_url} status={status} />

                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <RenameInput
                      initialValue={paper.title}
                      width={Math.min(400, Math.max(180, paper.title.length * 14))}
                      onCommit={(v) => onCommitRename(paper, v)}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <h3 className={cn("line-clamp-2 text-[15px] leading-[1.4]", status === "unread" ? "font-semibold text-zp-primary" : status === "read" ? "font-normal text-zp-tertiary" : "font-medium text-zp-primary")}>
                      {displayPaperTitle(paper.title)}
                    </h3>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-0.5">
                  {/* 星标：独立响应，不触发选择 */}
                  <IconTooltip label={paper.starred ? "取消星标" : "添加星标"}><button
                    type="button"
                    aria-label={paper.starred ? "取消星标" : "添加星标"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleStar(paper);
                    }}
                    className={cn(
                      "pressable flex h-5 w-5 items-center justify-center transition-opacity",
                      paper.starred
                        ? "text-zp-primary opacity-100"
                        : "text-zp-quaternary opacity-0 group-hover:opacity-100 hover:text-zp-primary focus-visible:opacity-100"
                    )}
                  >
                    <Star
                      className={cn("h-[18px] w-[18px]", paper.starred && "fill-current")}
                      strokeWidth={1.8}
                    />
                  </button></IconTooltip>

                  {/* ⋯ 更多菜单（与右键菜单同构） */}
                  <IconTooltip label="更多操作">
                  <MenuPrimitive.Root>
                    <MenuPrimitive.Trigger
                      render={
                        <button
                          type="button"
                          aria-label="更多操作"
                          className="pressable flex h-7 w-7 items-center justify-center rounded-full text-zp-quaternary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zp-surface-hover hover:text-zp-primary focus-visible:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      }
                    />
                    <MenuPrimitive.Portal>
                      <MenuPrimitive.Positioner
                        align="end"
                        alignOffset={0}
                        sideOffset={4}
                        className="isolate z-50"
                      >
                        <MenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                          <PaperMenuItems
                            Item={MenuPrimitive.Item}
                            actions={menuActions}
                            selectionMode={selectionMode}
                            planMenuSlot={renderPlanSubmenu(
                              MenuPrimitive as unknown as PlanMenuPrimitives,
                            )}
                          />
                        </MenuPrimitive.Popup>
                      </MenuPrimitive.Positioner>
                    </MenuPrimitive.Portal>
                  </MenuPrimitive.Root>
                  </IconTooltip>
                </div>
              </div>

              {/* 期刊 / 会议：单行截断 */}
              {paper.venue && (
                <p className="truncate pl-[42px] text-[13px] leading-[1.5] text-zp-tertiary">
                  {paper.venue}
                </p>
              )}

              {progress && <div role="progressbar" aria-valuenow={Math.round(percentRef.current)} aria-valuemin={0} aria-valuemax={100} aria-label="解析进度" className="ml-[42px] mt-2 h-1 overflow-hidden rounded-full bg-zp-surface-hover"><div className="h-full rounded-full bg-primary/65 transition-[width] duration-300" style={{ width: `${percentRef.current}%` }} /></div>}

              {/* footer：低强调的解析状态 + 归属文件夹（最多 3 个，点击跳转） */}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[42px]">
                <span
                  className={cn(
                    "inline-flex h-5 items-center text-[11px] leading-none",
                    st.className
                  )}
                >
                  {st.label}
                </span>
                {/* 阅读计划截止日期 pill：逾期未读标红 */}
                {duePill && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-[1.3] font-medium",
                      duePill.tone === "red"
                        ? "bg-red-500/10 text-red-600"
                        : duePill.tone === "amber"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-zp-surface-hover text-zp-tertiary"
                    )}
                  >
                    <CalendarClock className="h-3 w-3" strokeWidth={1.8} />
                    {duePill.text}
                  </span>
                )}
                {paper.parse_status !== "ready" && (
                  <button
                    type="button"
                    disabled={parsing}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onParse(paper.id);
                    }}
                    className="text-[11px] text-zp-quaternary underline-offset-2 transition-colors hover:text-zp-primary hover:underline disabled:opacity-50"
                  >
                    {parsing
                      ? "解析中…"
                      : paper.parse_status === "failed"
                        ? "重新解析"
                        : "解析"}
                  </button>
                )}
                {paperFolders.slice(0, 3).map((f) => {
                  const c = folderColor(f.color);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      title={f.tags.length > 0 ? `${f.name} · ${f.tags.join(" / ")}` : f.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToFolder(f.id);
                      }}
                      className="pressable flex max-w-28 items-center gap-1 rounded-md bg-zp-surface-hover px-1.5 py-0.5 text-[11px] text-zp-quaternary transition-colors hover:text-zp-primary"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.swatch }}
                      />
                      <span className="truncate">{f.name}</span>
                    </button>
                  );
                })}
                {paperFolders.length > 3 && (
                  <span className="text-[11px] text-zp-quaternary">
                    +{paperFolders.length - 3}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        }
      />
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner alignOffset={4} className="isolate z-50">
          <ContextMenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <PaperMenuItems
              Item={ContextMenuPrimitive.Item}
              actions={menuActions}
              selectionMode={selectionMode}
              planMenuSlot={renderPlanSubmenu(
                ContextMenuPrimitive as unknown as PlanMenuPrimitives,
              )}
            />
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
