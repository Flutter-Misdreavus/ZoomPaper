import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { useState } from "react";
import { Check, MoreHorizontal, Star } from "lucide-react";
import { cn, displayPaperTitle, formatTime } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import type { Folder, Paper, ReadingPlan, ReadingStatus } from "@/lib/api";
import { PaperMenuItems, type PaperMenuActions } from "./paperMenu";
import { PlanSubmenu, type PlanMenuPrimitives } from "./planMenu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { useLongPressSelection } from "@/hooks/useLongPressSelection";
import { VenueBadge } from "./VenueBadge";
import { RenameInput } from "./RenameInput";

export interface PaperTableProps {
  papers: Paper[];
  folders: Folder[];
  plans: ReadingPlan[];
  selectedIds: ReadonlySet<string>;
  selectionMode: boolean;
  onLongPress: (paperId: string) => void;
  focusedId: string | null;
  currentFolderId: string | null;
  parsingId: string | null;
  onFocus: (paper: Paper) => void;
  onToggle: (paperId: string) => void;
  onSelectionDragStart: (paperId: string, selected: boolean) => void;
  onSelectionDragEnter: (paperId: string) => void;
  onOpen: (paperId: string) => void;
  onRename: (paper: Paper) => void;
  renamingId: string | null;
  onCommitRename: (paper: Paper, title: string) => void;
  onCancelRename: () => void;
  onPickFolder: (paper: Paper) => void;
  onSetStatus: (paper: Paper, status: ReadingStatus) => void;
  onBulkSetStatus: (status: ReadingStatus) => void;
  onBulkDelete: () => void;
  onPlanQuickAdd: (paper: Paper, planId: string | null, dueTs: number | null) => void;
  onPlanRemove: (paper: Paper, planId: string) => void;
  onPlanCustomDate: (paper: Paper, planId: string | null) => void;
  onToggleStar: (paper: Paper) => void;
  onParse: (paperId: string) => void;
  onDelete: (paper: Paper) => void;
  onRemoveFromCurrentFolder: (paper: Paper) => void;
}

export function PaperTable(props: PaperTableProps) {
  const folderById = new Map(props.folders.map((folder) => [folder.id, folder]));
  const [targetPlans, setTargetPlans] = useState<Record<string, string>>({});
  const longPress = useLongPressSelection((paperId) => {
    props.onLongPress(paperId);
    props.onSelectionDragStart(paperId, props.selectedIds.has(paperId));
  });
  const columns = props.selectionMode
    ? "grid-cols-[36px_minmax(280px,1fr)_minmax(140px,0.55fr)_120px_118px_38px]"
    : "grid-cols-[minmax(280px,1fr)_minmax(140px,0.55fr)_120px_118px_38px]";

  return (
    <div className="min-w-[760px] text-[13px]">
      <div className={cn("grid h-9 items-center border-b border-zp-border px-2 text-xs text-zp-quaternary", columns)}>
        {props.selectionMode && <span />}
        <span>标题</span>
        <span>期刊 / 会议</span>
        <span>文件夹</span>
        <span>最后阅读</span>
        <span />
      </div>
      <div>
        {props.papers.map((paper) => {
          const selected = props.selectedIds.has(paper.id);
          const focused = props.focusedId === paper.id;
          const paperFolders = paper.folder_ids.map((id) => folderById.get(id)).filter((f): f is Folder => Boolean(f));
          const containingPlan = props.plans.find((p) => p.type === "papers" && p.items.some((item) => item.paper_id === paper.id)) ?? null;
          const activePlans = props.plans.filter((p) => p.type === "papers" && p.active);
          const effectivePlan = containingPlan ?? activePlans.find((plan) => plan.id === targetPlans[paper.id]) ?? activePlans[0] ?? null;
          const useBulkActions = props.selectionMode && selected;
          const actions: PaperMenuActions = {
            onOpen: () => props.onOpen(paper.id),
            onRename: () => props.onRename(paper),
            onPickFolder: () => props.onPickFolder(paper),
            onRemoveFromCurrentFolder: props.currentFolderId ? () => props.onRemoveFromCurrentFolder(paper) : undefined,
            onSetStatus: (status) => useBulkActions ? props.onBulkSetStatus(status) : props.onSetStatus(paper, status),
            currentStatus: paper.reading_status as ReadingStatus,
            onDelete: () => useBulkActions ? props.onBulkDelete() : props.onDelete(paper),
          };

          return (
            <ContextMenuPrimitive.Root key={paper.id}>
              <ContextMenuPrimitive.Trigger render={<div
              role="row"
              data-paper-item
              tabIndex={0}
              aria-selected={props.selectionMode ? selected : focused}
              {...longPress.bind(paper.id)}
              onContextMenu={(event) => { if (longPress.suppressContextMenu(paper.id)) event.preventDefault(); }}
              onClick={(event) => {
                if (longPress.consumeClick(paper.id)) { event.preventDefault(); event.stopPropagation(); return; }
                if (props.selectionMode) props.onToggle(paper.id);
                else props.onFocus(paper);
              }}
              onDoubleClick={() => { if (!props.selectionMode) props.onOpen(paper.id); }}
              onPointerEnter={() => { if (props.selectionMode) props.onSelectionDragEnter(paper.id); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (props.selectionMode) props.onToggle(paper.id);
                  else props.onOpen(paper.id);
                }
                if (event.key === " " && !event.repeat) {
                  event.preventDefault();
                  if (props.selectionMode) props.onToggle(paper.id);
                  else props.onLongPress(paper.id);
                }
              }}
              className={cn(
                "group grid min-h-11 cursor-default select-none items-center border-b border-zp-border/70 px-2 outline-none transition-colors",
                columns,
                (props.selectionMode ? selected : focused) ? "bg-[#eceeeb] dark:bg-zp-surface-active" : "hover:bg-zp-surface-hover",
              )}
            />}>
              {props.selectionMode && <div className="flex items-center justify-center">
                <button
                  type="button"
                  aria-label={selected ? "取消选择" : "选择论文"}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || !event.isPrimary) return;
                    event.preventDefault();
                    event.stopPropagation();
                    props.onSelectionDragStart(paper.id, selected);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    // 键盘触发的 click 没有 pointerdown，仍保留完整键盘可访问性。
                    if (event.detail === 0) props.onToggle(paper.id);
                  }}
                  className={cn(
                    "flex h-4 w-4 touch-none items-center justify-center rounded-[4px] border transition-colors",
                    selected ? "border-zp-primary bg-zp-primary text-white" : "border-zp-border bg-white dark:bg-zp-surface",
                  )}
                >
                  {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                </button>
              </div>}

              <div className="flex min-w-0 items-center gap-2 pr-4">
                <VenueBadge venue={paper.venue} sourceUrl={paper.source_url} iconUrl={paper.source_icon_url} compact status={paper.reading_status as ReadingStatus} />
                {props.renamingId === paper.id ? (
                  <RenameInput
                    initialValue={paper.title}
                    width={Math.min(420, Math.max(180, paper.title.length * 12))}
                    onCommit={(title) => props.onCommitRename(paper, title)}
                    onCancel={props.onCancelRename}
                  />
                ) : (
                  <span className={cn("truncate", paper.reading_status === "unread" ? "font-semibold text-zp-primary" : paper.reading_status === "read" ? "font-normal text-zp-tertiary" : "font-medium text-zp-primary")}>{displayPaperTitle(paper.title)}</span>
                )}
                <IconTooltip label={paper.starred ? "取消收藏" : "收藏论文"}>
                  <button
                    type="button"
                    aria-label={paper.starred ? "取消收藏" : "收藏论文"}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onToggleStar(paper);
                    }}
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all hover:bg-white dark:hover:bg-zp-surface",
                      paper.starred
                        ? "text-amber-500"
                        : "text-zp-quaternary opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                  >
                    <Star className={cn("h-3.5 w-3.5", paper.starred && "fill-current")} />
                  </button>
                </IconTooltip>
              </div>
              <span className="truncate pr-4 text-zp-secondary">{paper.venue || "—"}</span>
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {paperFolders.length === 0 ? <span className="text-zp-tertiary">—</span> : paperFolders.slice(0, 2).map((folder) => (
                  <span key={folder.id} title={folder.name} className="flex min-w-0 items-center gap-1 text-xs text-zp-secondary">
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: folderColor(folder.color).swatch }} />
                    <span className="truncate">{folder.name}</span>
                  </span>
                ))}
              </div>
              <span className="truncate text-xs text-zp-quaternary">{paper.last_read_at ? formatTime(paper.last_read_at) : "—"}</span>
              <IconTooltip label="更多操作"><MenuPrimitive.Root>
                <MenuPrimitive.Trigger render={<button type="button" aria-label="更多操作" onClick={(event) => event.stopPropagation()} className="flex h-7 w-7 items-center justify-center rounded-md text-zp-quaternary opacity-0 hover:bg-white hover:text-zp-primary group-hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-zp-surface"><MoreHorizontal className="h-4 w-4" /></button>} />
                <MenuPrimitive.Portal>
                  <MenuPrimitive.Positioner align="end" sideOffset={4} className="isolate z-50">
                    <MenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
                      <PaperMenuItems
                        Item={MenuPrimitive.Item}
                        actions={actions}
                        selectionMode={props.selectionMode}
                        planMenuSlot={<PlanSubmenu
                          P={MenuPrimitive as unknown as PlanMenuPrimitives}
                          activePlans={activePlans}
                          containingPlan={containingPlan}
                          currentDue={containingPlan?.items.find((item) => item.paper_id === paper.id)?.due_date ?? null}
                          targetPlanId={effectivePlan?.id ?? null}
                          onSelectTarget={(planId) => setTargetPlans((current) => ({ ...current, [paper.id]: planId }))}
                          onQuickDate={(due) => props.onPlanQuickAdd(paper, effectivePlan?.id ?? null, due)}
                          onCustomDate={() => props.onPlanCustomDate(paper, effectivePlan?.id ?? null)}
                          onRemove={containingPlan ? () => props.onPlanRemove(paper, containingPlan.id) : null}
                        />}
                      />
                    </MenuPrimitive.Popup>
                  </MenuPrimitive.Positioner>
                </MenuPrimitive.Portal>
              </MenuPrimitive.Root></IconTooltip>
              </ContextMenuPrimitive.Trigger>
              <ContextMenuPrimitive.Portal>
                <ContextMenuPrimitive.Positioner alignOffset={4} className="isolate z-50">
                  <ContextMenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
                    <PaperMenuItems
                      Item={ContextMenuPrimitive.Item}
                      actions={actions}
                      selectionMode={props.selectionMode}
                      planMenuSlot={<PlanSubmenu
                        P={ContextMenuPrimitive as unknown as PlanMenuPrimitives}
                        activePlans={activePlans}
                        containingPlan={containingPlan}
                        currentDue={containingPlan?.items.find((item) => item.paper_id === paper.id)?.due_date ?? null}
                        targetPlanId={effectivePlan?.id ?? null}
                        onSelectTarget={(planId) => setTargetPlans((current) => ({ ...current, [paper.id]: planId }))}
                        onQuickDate={(due) => props.onPlanQuickAdd(paper, effectivePlan?.id ?? null, due)}
                        onCustomDate={() => props.onPlanCustomDate(paper, effectivePlan?.id ?? null)}
                        onRemove={containingPlan ? () => props.onPlanRemove(paper, containingPlan.id) : null}
                      />}
                    />
                  </ContextMenuPrimitive.Popup>
                </ContextMenuPrimitive.Positioner>
              </ContextMenuPrimitive.Portal>
            </ContextMenuPrimitive.Root>
          );
        })}
      </div>
    </div>
  );
}
