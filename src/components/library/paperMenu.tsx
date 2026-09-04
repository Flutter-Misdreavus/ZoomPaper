/**
 * 论文操作菜单共享项：右键上下文菜单与「⋯」下拉菜单复用同一组动作。
 * Item 为 Base UI 的 Menu.Item 或 ContextMenu.Item（二者 props 兼容）。
 */
import {
  BookOpen,
  FolderMinus,
  FolderPlus,
  ListPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadingStatus } from "@/lib/api";

export const MENU_ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/** 状态圆点：未读=实心主色 / 在读=实心灰 / 已读=描边 */
export function StatusDot({ status }: { status: ReadingStatus }) {
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        status === "unread" && "bg-zp-primary",
        status === "reading" && "bg-zp-tertiary",
        status === "read" && "border border-zp-border"
      )}
    />
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
  /** 加入当前进行中的指派论文计划（无则自动新建） */
  onAddToPlan?: () => void;
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

export function PaperMenuItems({ Item, actions }: { Item: MenuItemLike; actions: PaperMenuActions }) {
  return (
    <>
      <Item className={MENU_ITEM_CLASS} onClick={actions.onOpen}>
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        打开
      </Item>
      <Item className={MENU_ITEM_CLASS} onClick={actions.onRename}>
        <Pencil className="h-4 w-4 text-muted-foreground" />
        重命名
      </Item>
      <Item className={MENU_ITEM_CLASS} onClick={actions.onPickFolder}>
        <FolderPlus className="h-4 w-4 text-muted-foreground" />
        添加到文件夹…
      </Item>
      {actions.onRemoveFromCurrentFolder && (
        <Item className={MENU_ITEM_CLASS} onClick={actions.onRemoveFromCurrentFolder}>
          <FolderMinus className="h-4 w-4 text-muted-foreground" />
          从当前文件夹移除
        </Item>
      )}
      <div className="my-1 h-px bg-border" />
      {actions.onAddToPlan && (
        <Item className={MENU_ITEM_CLASS} onClick={actions.onAddToPlan}>
          <ListPlus className="h-4 w-4 text-muted-foreground" />
          加入阅读计划
        </Item>
      )}
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
