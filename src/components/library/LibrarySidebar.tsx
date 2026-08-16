import { useRef, useState } from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { motion, useReducedMotion } from "motion/react";
import {
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Library as LibraryIcon,
  Pencil,
  Palette,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import {
  buildFolderTree,
  folderPaperCount,
  readDragPaperIds,
  type FolderNode,
  type LibraryView,
} from "@/lib/folders";
import type { Folder, Paper } from "@/lib/api";
import { RenameInput } from "./RenameInput";

export interface SidebarProps {
  folders: Folder[];
  papers: Paper[];
  view: LibraryView;
  onSelectView: (v: LibraryView) => void;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  renaming: { kind: "folder"; id: string } | null;
  onStartRename: (folder: Folder) => void;
  onCommitRename: (folder: Folder, name: string) => void;
  onCancelRename: () => void;
  onCreateSubfolder: (parentId: string) => void;
  onEditFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  /** 拖拽投放：folderId 为目标文件夹；null = 未分类（移除全部归属） */
  onDropPapers: (paperIds: string[], folderId: string | null) => void;
}

const MENU_ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/** 拖拽高亮：用 enter/leave 计数避免子元素间闪烁 */
function useDropHighlight(onDrop: (ids: string[]) => void) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  return {
    active,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        e.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        depth.current = 0;
        setActive(false);
        const ids = readDragPaperIds(e.dataTransfer);
        if (ids.length) onDrop(ids);
      },
    },
  };
}

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  papers: Paper[];
  view: LibraryView;
  onSelectView: (v: LibraryView) => void;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  renaming: { kind: "folder"; id: string } | null;
  onStartRename: (folder: Folder) => void;
  onCommitRename: (folder: Folder, name: string) => void;
  onCancelRename: () => void;
  onCreateSubfolder: (parentId: string) => void;
  onEditFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onDropPapers: (paperIds: string[], folderId: string | null) => void;
}

function FolderRow({
  node,
  depth,
  papers,
  view,
  onSelectView,
  expanded,
  onToggleExpand,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCreateSubfolder,
  onEditFolder,
  onDeleteFolder,
  onDropPapers,
}: FolderRowProps) {
  const f = node.folder;
  const c = folderColor(f.color);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(f.id);
  const isActive = view.type === "folder" && view.folderId === f.id;
  const count = folderPaperCount(papers, f.id);
  const isRenaming = renaming?.kind === "folder" && renaming.id === f.id;
  const reduceMotion = useReducedMotion();
  const drop = useDropHighlight((ids) => onDropPapers(ids, f.id));

  return (
    <div>
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          render={
            <div
              {...drop.handlers}
              onClick={() => onSelectView({ type: "folder", folderId: f.id })}
              className={cn(
                "group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-sm transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground/85 hover:bg-accent/60",
                drop.active && "bg-accent ring-2 ring-primary/50"
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={isOpen ? "收起" : "展开"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(f.id);
                  }}
                  className="pressable flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <motion.span
                    animate={{ rotate: isOpen ? 90 : 0 }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", bounce: 0, duration: 0.25 }
                    }
                    className="flex"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </motion.span>
                </button>
              ) : (
                <span className="h-4 w-4 shrink-0" />
              )}
              {isRenaming ? (
                <RenameInput
                  initialValue={f.name}
                  width={140}
                  onCommit={(v) => onCommitRename(f, v)}
                  onCancel={onCancelRename}
                />
              ) : (
                <>
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {isOpen && hasChildren ? (
                      <FolderOpen className="h-4 w-4" style={{ color: c.swatch }} />
                    ) : (
                      <FolderIcon className="h-4 w-4" style={{ color: c.swatch }} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {count > 0 && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  )}
                </>
              )}
            </div>
          }
        />
        <ContextMenuPrimitive.Portal>
          <ContextMenuPrimitive.Positioner alignOffset={4} className="isolate z-50">
            <ContextMenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                onClick={() => onCreateSubfolder(f.id)}
              >
                <FolderPlus className="h-4 w-4 text-muted-foreground" />
                新建子文件夹
              </ContextMenuPrimitive.Item>
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                onClick={() => onStartRename(f)}
              >
                <Pencil className="h-4 w-4 text-muted-foreground" />
                重命名
              </ContextMenuPrimitive.Item>
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                onClick={() => onEditFolder(f)}
              >
                <Palette className="h-4 w-4 text-muted-foreground" />
                颜色与标签…
              </ContextMenuPrimitive.Item>
              <div className="my-1 h-px bg-border" />
              <ContextMenuPrimitive.Item
                className={cn(
                  MENU_ITEM_CLASS,
                  "text-destructive data-[highlighted]:bg-destructive/10"
                )}
                onClick={() => onDeleteFolder(f)}
              >
                <Trash2 className="h-4 w-4" />
                删除文件夹
              </ContextMenuPrimitive.Item>
            </ContextMenuPrimitive.Popup>
          </ContextMenuPrimitive.Positioner>
        </ContextMenuPrimitive.Portal>
      </ContextMenuPrimitive.Root>

      {isOpen && hasChildren &&
        node.children.map((child) => (
          <FolderRow
            key={child.folder.id}
            node={child}
            depth={depth + 1}
            papers={papers}
            view={view}
            onSelectView={onSelectView}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            renaming={renaming}
            onStartRename={onStartRename}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onCreateSubfolder={onCreateSubfolder}
            onEditFolder={onEditFolder}
            onDeleteFolder={onDeleteFolder}
            onDropPapers={onDropPapers}
          />
        ))}
    </div>
  );
}

export function LibrarySidebar(props: SidebarProps) {
  const {
    folders,
    papers,
    view,
    onSelectView,
    expanded,
    onToggleExpand,
    renaming,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onCreateSubfolder,
    onEditFolder,
    onDeleteFolder,
    onDropPapers,
  } = props;

  const tree = buildFolderTree(folders);
  const uncategorizedCount = papers.filter((p) => p.folder_ids.length === 0).length;
  const allDrop = useDropHighlight((ids) => onDropPapers(ids, null));

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {/* 全部论文 */}
        <button
          type="button"
          onClick={() => onSelectView({ type: "all" })}
          className={cn(
            "pressable flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
            view.type === "all"
              ? "bg-accent text-accent-foreground"
              : "text-foreground/85 hover:bg-accent/60"
          )}
        >
          <LibraryIcon className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-left">全部论文</span>
          <span className="text-xs tabular-nums text-muted-foreground">{papers.length}</span>
        </button>

        {/* 文件夹树 */}
        <div className="mt-1 flex flex-col">
          {tree.map((node) => (
            <FolderRow
              key={node.folder.id}
              node={node}
              depth={0}
              papers={papers}
              view={view}
              onSelectView={onSelectView}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              renaming={renaming}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onCreateSubfolder={onCreateSubfolder}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
              onDropPapers={onDropPapers}
            />
          ))}
        </div>

        {/* 未分类 */}
        <button
          type="button"
          onClick={() => onSelectView({ type: "uncategorized" })}
          {...allDrop.handlers}
          className={cn(
            "pressable mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
            view.type === "uncategorized"
              ? "bg-accent text-accent-foreground"
              : "text-foreground/85 hover:bg-accent/60",
            allDrop.active && "bg-accent ring-2 ring-primary/50"
          )}
        >
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-left">未分类</span>
          <span className="text-xs tabular-nums text-muted-foreground">{uncategorizedCount}</span>
        </button>
      </div>

      {/* 新建文件夹 */}
      <div className="border-t p-2">
        <button
          type="button"
          onClick={() => onCreateSubfolder("__root__")}
          className="pressable flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
          新建文件夹
        </button>
      </div>
    </aside>
  );
}
