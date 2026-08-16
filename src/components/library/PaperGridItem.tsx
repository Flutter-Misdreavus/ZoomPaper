import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { FileText, MoreHorizontal } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import { PAPER_DRAG_MIME } from "@/lib/folders";
import type { Folder, Paper } from "@/lib/api";
import { PaperMenuItems, type PaperMenuActions } from "./paperMenu";
import { RenameInput } from "./RenameInput";
import { STATUS_STYLE } from "./PaperCard";

const STATUS_ICON_COLOR: Record<string, string> = {
  ready: "text-primary",
  parsing: "text-amber-500",
  unparsed: "text-muted-foreground/60",
  failed: "text-destructive",
};

export interface PaperGridItemProps {
  paper: Paper;
  folders: Folder[];
  selected: boolean;
  selectedIds: ReadonlySet<string>;
  isRenaming: boolean;
  currentFolderId: string | null;
  onSelect: (paperId: string, additive: boolean) => void;
  onOpen: (paperId: string) => void;
  onStartRename: (paper: Paper) => void;
  onCommitRename: (paper: Paper, title: string) => void;
  onCancelRename: () => void;
  /** 打开归属面板；未选中该论文时以它为目标 */
  onPickFolder: (paper: Paper) => void;
  onDelete: (paper: Paper) => void;
  onRemoveFromCurrentFolder: (paper: Paper) => void;
  onJumpToFolder: (folderId: string) => void;
}

export function PaperGridItem(props: PaperGridItemProps) {
  const {
    paper,
    folders,
    selected,
    selectedIds,
    isRenaming,
    currentFolderId,
    onSelect,
    onOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onPickFolder,
    onDelete,
    onRemoveFromCurrentFolder,
    onJumpToFolder,
  } = props;

  const st = STATUS_STYLE[paper.parse_status] ?? STATUS_STYLE.unparsed;
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const reduceMotion = useReducedMotion();
  const badges = paper.folder_ids
    .map((id) => folderById.get(id))
    .filter((f): f is Folder => Boolean(f));

  const menuActions: PaperMenuActions = {
    onOpen: () => onOpen(paper.id),
    onRename: () => onStartRename(paper),
    onPickFolder: () => onPickFolder(paper),
    onRemoveFromCurrentFolder: currentFolderId
      ? () => onRemoveFromCurrentFolder(paper)
      : undefined,
    onDelete: () => onDelete(paper),
  };

  function handleDragStart(e: React.DragEvent) {
    const ids = selected ? [...selectedIds] : [paper.id];
    if (!selected) onSelect(paper.id, false);
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
            className="group relative"
          >
            <div
              draggable
              onDragStart={handleDragStart}
              tabIndex={0}
              role="button"
              aria-label={paper.title}
              onClick={(e) => onSelect(paper.id, e.metaKey || e.ctrlKey)}
              onDoubleClick={() => onOpen(paper.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(paper.id);
                }
              }}
              className={cn(
                "flex cursor-default select-none flex-col items-center gap-2 rounded-xl border bg-card p-4 pt-5 text-center outline-none transition-colors",
                selected
                  ? "border-primary/60 ring-2 ring-primary/40"
                  : "border-transparent hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              <FileText
                className={cn("h-14 w-14", STATUS_ICON_COLOR[paper.parse_status] ?? "text-muted-foreground/60")}
                strokeWidth={1.4}
              />
              {isRenaming ? (
                <RenameInput
                  initialValue={paper.title}
                  width={140}
                  onCommit={(v) => onCommitRename(paper, v)}
                  onCancel={onCancelRename}
                />
              ) : (
                <span className="line-clamp-2 min-h-10 text-sm font-medium leading-5">
                  {paper.title}
                </span>
              )}
              {badges.length > 0 && (
                <span className="flex max-w-full flex-wrap items-center justify-center gap-1">
                  {badges.slice(0, 4).map((f) => {
                    const c = folderColor(f.color);
                    return (
                      <button
                        key={f.id}
                        type="button"
                        title={f.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          onJumpToFolder(f.id);
                        }}
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: c.swatch }}
                      />
                    );
                  })}
                  {badges.length > 4 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{badges.length - 4}
                    </span>
                  )}
                </span>
              )}
            </div>

            {/* 状态徽标（右上角） */}
            <Badge
              variant={st.variant}
              className="absolute top-1.5 right-1.5 px-1.5 py-0 text-[10px]"
            >
              {st.label}
            </Badge>

            {/* ⋯ 操作菜单 */}
            <MenuPrimitive.Root>
              <MenuPrimitive.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    title="更多操作"
                    className="pressable absolute top-1.5 left-1.5 h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                }
              />
              <MenuPrimitive.Portal>
                <MenuPrimitive.Positioner
                  align="start"
                  alignOffset={0}
                  sideOffset={4}
                  className="isolate z-50"
                >
                  <MenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                    <PaperMenuItems Item={MenuPrimitive.Item} actions={menuActions} />
                  </MenuPrimitive.Popup>
                </MenuPrimitive.Positioner>
              </MenuPrimitive.Portal>
            </MenuPrimitive.Root>
          </motion.div>
        }
      />
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner alignOffset={4} className="isolate z-50">
          <ContextMenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <PaperMenuItems Item={ContextMenuPrimitive.Item} actions={menuActions} />
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
