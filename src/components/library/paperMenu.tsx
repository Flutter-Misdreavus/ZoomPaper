/**
 * 论文操作菜单共享项：右键上下文菜单与「⋯」下拉菜单复用同一组动作。
 * Item 为 Base UI 的 Menu.Item 或 ContextMenu.Item（二者 props 兼容）。
 */
import {
  BookOpen,
  Check,
  FolderMinus,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadingStatus } from "@/lib/api";

export const MENU_ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/** 与论文库一致：未读=主色点 / 在读=琥珀点 / 已读=灰色勾。 */
export function StatusDot({ status }: { status: ReadingStatus }) {
  if (status === "read") {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-zp-tertiary text-white">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      </span>
    );
  }
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          status === "unread" && "bg-zp-primary",
          status === "reading" && "bg-amber-500",
        )}
      />
    </span>
  );
}

export interface PaperMenuActions {
  onOpen: () => void;
  onRename: () => void;
  /** 以目标论文（或当前多选）打开归属面板 */
  onPickFolder: () => void;
  /** 仅文件夹视图下出现：从当前文件夹移除归属 */
  onRemoveFromCurrentFolder?: () => void;
  /** 标记阅读状态 */
  onSetStatus: (status: ReadingStatus) => void;
  /** 当前阅读状态（用于高亮菜单项） */
  currentStatus: ReadingStatus;
  onDelete: () => void;
}

type MenuItemLike = React.ComponentType<{
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}>;

export function PaperMenuItems({
  Item,
  actions,
  planMenuSlot,
  selectionMode = false,
}: {
  Item: MenuItemLike;
  actions: PaperMenuActions;
  /** 「加入阅读计划」子菜单插槽（由 PaperCard 按具体菜单原语构建） */
  planMenuSlot?: React.ReactNode;
  /** 多选时隐藏只能作用于单篇论文的操作。 */
  selectionMode?: boolean;
}) {
  return (
    <>
      {!selectionMode && <>
        <Item className={MENU_ITEM_CLASS} onClick={actions.onOpen}>
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          打开
        </Item>
        <Item className={MENU_ITEM_CLASS} onClick={actions.onRename}>
          <Pencil className="h-4 w-4 text-muted-foreground" />
          重命名
        </Item>
      </>}
      <Item className={MENU_ITEM_CLASS} onClick={actions.onPickFolder}>
        <FolderPlus className="h-4 w-4 text-muted-foreground" />
        添加到文件夹…
      </Item>
      {!selectionMode && actions.onRemoveFromCurrentFolder && (
        <Item className={MENU_ITEM_CLASS} onClick={actions.onRemoveFromCurrentFolder}>
          <FolderMinus className="h-4 w-4 text-muted-foreground" />
          从当前文件夹移除
        </Item>
      )}
      <div className="my-1 h-px bg-border" />
      {!selectionMode && planMenuSlot}
      <Item
        className={cn(MENU_ITEM_CLASS, actions.currentStatus === "unread" && "font-medium")}
        onClick={() => actions.onSetStatus("unread")}
      >
        <StatusDot status="unread" />
        标记为未读
      </Item>
      <Item
        className={cn(MENU_ITEM_CLASS, actions.currentStatus === "reading" && "font-medium")}
        onClick={() => actions.onSetStatus("reading")}
      >
        <StatusDot status="reading" />
        标记为在读
      </Item>
      <Item
        className={cn(MENU_ITEM_CLASS, actions.currentStatus === "read" && "font-medium")}
        onClick={() => actions.onSetStatus("read")}
      >
        <StatusDot status="read" />
        标记为已读
      </Item>
      <div className="my-1 h-px bg-border" />
      <Item
        className={cn(
          MENU_ITEM_CLASS,
          "text-destructive data-[highlighted]:bg-destructive/10"
        )}
        onClick={actions.onDelete}
      >
        <Trash2 className="h-4 w-4" />
        删除
      </Item>
    </>
  );
}
