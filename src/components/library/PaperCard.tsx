import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Loader2, MoreHorizontal } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import { PAPER_DRAG_MIME } from "@/lib/folders";
import type { Folder, Paper } from "@/lib/api";
import { PaperMenuItems, type PaperMenuActions } from "./paperMenu";
import { RenameInput } from "./RenameInput";

export const STATUS_STYLE: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  ready: { label: "已解析", variant: "default" },
  parsing: { label: "解析中…", variant: "secondary" },
  unparsed: { label: "未解析", variant: "outline" },
  failed: { label: "解析失败", variant: "destructive" },
};

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

export interface PaperCardProps {
  paper: Paper;
  folders: Folder[];
  selected: boolean;
  selectedIds: ReadonlySet<string>;
  isRenaming: boolean;
  parsing: boolean;
  /** 当前处于某文件夹视图时的 folderId；null = 全部/未分类视图 */
  currentFolderId: string | null;
  onSelect: (paperId: string, additive: boolean) => void;
  onOpen: (paperId: string) => void;
  onStartRename: (paper: Paper) => void;
  onCommitRename: (paper: Paper, title: string) => void;
  onCancelRename: () => void;
  /** 打开归属面板；未选中该论文时以它为目标 */
  onPickFolder: (paper: Paper) => void;
  onParse: (paperId: string) => void;
  onDelete: (paper: Paper) => void;
  onRemoveFromCurrentFolder: (paper: Paper) => void;
  onJumpToFolder: (folderId: string) => void;
}

export function PaperCard(props: PaperCardProps) {
  const {
    paper,
    folders,
    selected,
    selectedIds,
    isRenaming,
    parsing,
    currentFolderId,
    onSelect,
    onOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onPickFolder,
    onParse,
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
          >
            <Card
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
                "group cursor-default select-none outline-none transition-colors",
                selected
                  ? "ring-2 ring-primary/60"
                  : "hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring",
                paper.parse_status === "failed" && "border-destructive/40"
              )}
            >
              <CardContent className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {isRenaming ? (
                      <RenameInput
                        initialValue={paper.title}
                        width={Math.min(480, Math.max(200, paper.title.length * 14))}
                        onCommit={(v) => onCommitRename(paper, v)}
                        onCancel={onCancelRename}
                      />
                    ) : (
                      <h3 className="truncate font-semibold">{paper.title}</h3>
                    )}
                    <Badge variant={st.variant}>{st.label}</Badge>
                  </div>
                  {paper.abstract && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {paper.abstract}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatDate(paper.created_at)}
                    </span>
                    {badges.length > 0 && (
                      <span className="flex flex-wrap items-center gap-1">
                        {badges.slice(0, 3).map((f) => {
                          const c = folderColor(f.color);
                          return (
                            <button
                              key={f.id}
                              type="button"
                              title={`${f.name}${f.tags.length ? " · " + f.tags.join(" / ") : ""}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onJumpToFolder(f.id);
                              }}
                              className="pressable flex items-center gap-1 rounded-full border bg-secondary/50 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: c.swatch }}
                              />
                              {f.name}
                            </button>
                          );
                        })}
                        {badges.length > 3 && (
                          <span className="text-[11px] text-muted-foreground">
                            +{badges.length - 3}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {paper.parse_status !== "ready" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={parsing}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onParse(paper.id);
                      }}
                    >
                      {parsing ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : null}
                      解析
                    </Button>
                  )}
                  {/* ⋯ 操作菜单（与右键菜单同构） */}
                  <MenuPrimitive.Root>
                    <MenuPrimitive.Trigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          title="更多操作"
                          className="pressable h-8 w-8 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
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
                          <PaperMenuItems Item={MenuPrimitive.Item} actions={menuActions} />
                        </MenuPrimitive.Popup>
                      </MenuPrimitive.Positioner>
                    </MenuPrimitive.Portal>
                  </MenuPrimitive.Root>
                </div>
              </CardContent>
            </Card>
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
