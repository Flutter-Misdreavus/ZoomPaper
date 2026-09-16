/**
 * 文件夹侧边栏（FolderSidebar）：220px，黑白灰体系。
 * 顶部「文件夹」小标题 + 全部论文 / 文件夹树 / 未分类 + 底部新建文件夹。
 * 保留右键菜单、内联重命名、拖拽归类；数量 badge 等宽数字右对齐。
 */
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

export interface FolderSidebarProps {
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

/** 文件夹行样式：active 加粗 + 同色系柔和底色；hover 变 primary（灰阶） */
function folderRowClass(isActive: boolean, dropActive: boolean) {
  return cn(
    "group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-[14px] transition-colors",
    isActive
      ? "font-medium text-zp-primary"
      : "text-zp-secondary hover:bg-zp-surface-hover hover:text-zp-primary",
    dropActive && "bg-zp-surface-hover ring-2 ring-zp-primary/40"
  );
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
  const tagTitle = f.tags.length > 0 ? f.tags.join(" · ") : undefined;

  return (
    <div>
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          render={
            <div
              {...drop.handlers}
              title={tagTitle}
              onClick={() => onSelectView({ type: "folder", folderId: f.id })}
              className={folderRowClass(isActive, drop.active)}
              style={{
                paddingLeft: 6 + depth * 14,
                // 选中行：同色系柔和底色（softLight，10% 透明度）
                backgroundColor: isActive ? c.softLight : undefined,
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={isOpen ? "收起" : "展开"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(f.id);
                  }}
                  className="pressable flex h-4 w-4 shrink-0 items-center justify-center text-zp-quaternary"
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
                    <span className="shrink-0 text-xs tabular-nums text-zp-quaternary">
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

/** 通用侧栏条目（全部论文 / 未分类） */
interface DropHandlers {
  onDragEnter: React.DragEventHandler<HTMLButtonElement>;
  onDragLeave: React.DragEventHandler<HTMLButtonElement>;
  onDragOver: React.DragEventHandler<HTMLButtonElement>;
  onDrop: React.DragEventHandler<HTMLButtonElement>;
}

function SidebarEntry({
  icon,
  label,
  count,
  active,
  dropActive,
  onClick,
  handlers,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  dropActive?: boolean;
  onClick: () => void;
  handlers?: DropHandlers;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...handlers}
      className={cn(
        "pressable flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-[14px] transition-colors",
        active
          ? "font-medium text-zp-primary"
          : "text-zp-secondary hover:text-zp-primary",
        dropActive && "bg-zp-surface-hover ring-2 ring-zp-primary/40"
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zp-quaternary">
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      <span className="text-xs tabular-nums text-zp-quaternary">{count}</span>
    </button>
  );
}

export function FolderSidebar(props: FolderSidebarProps) {
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
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-zp-border">
      {/* 文件夹小标题：12px uppercase，quaternary */}
      <div className="px-3 pt-5 pb-2 text-[12px] font-medium tracking-[0.05em] text-zp-quaternary uppercase">
        文件夹
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          <SidebarEntry
            icon={<LibraryIcon className="h-4 w-4" />}
            label="全部论文"
            count={papers.length}
            active={view.type === "all"}
            onClick={() => onSelectView({ type: "all" })}
          />

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

          <SidebarEntry
            icon={<FileText className="h-4 w-4" />}
            label="未分类"
            count={uncategorizedCount}
            active={view.type === "uncategorized"}
            dropActive={allDrop.active}
            onClick={() => onSelectView({ type: "uncategorized" })}
            handlers={allDrop.handlers}
          />
        </div>
      </div>

      {/* 新建文件夹：底部弱操作，留白区隔（无显式分割线） */}
      <div className="px-2 pb-4 pt-3">
        <button
          type="button"
          onClick={() => onCreateSubfolder("__root__")}
          className="pressable flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-[13px] text-zp-quaternary transition-colors hover:text-zp-primary"
        >
          <Plus className="h-4 w-4" />
          新建文件夹
        </button>
      </div>
    </aside>
  );
}
