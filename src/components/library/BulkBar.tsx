/**
 * 批量操作栏（BulkBar）：选中 ≥1 篇论文时浮现。
 * 深色背景（bg-primary），圆角 10px；左「X 篇已选」，中区操作按钮组
 * （标记已读 / 标记状态菜单 / 添加到文件夹 / 删除），右侧关闭按钮。
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronDown, FolderPlus, Trash2, X } from "lucide-react";
import type { ReadingStatus } from "@/lib/api";

const BAR_BTN =
  "flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-white/20";

const MENU_ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

const STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  read: "已读",
};

interface Props {
  count: number;
  /** 一键标记已读 */
  onMarkRead: () => void;
  /** 标记状态菜单：未读 / 在读 / 已读 */
  onSetStatus: (status: ReadingStatus) => void;
  /** 添加到文件夹 */
  onPickFolder: () => void;
  onDelete: () => void;
  /** 关闭（清空选择） */
  onClose: () => void;
}

export function BulkBar({ count, onMarkRead, onSetStatus, onPickFolder, onDelete, onClose }: Props) {
  return (
    <div className="zp-bulk-bar mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-[10px] bg-zp-primary px-6 py-2.5 shadow-lg">
      {/* 左区：计数 */}
      <span className="mr-1 shrink-0 text-sm font-medium text-white tabular-nums">
        {count} 篇已选
      </span>

      {/* 中区：操作按钮组 */}
      <button type="button" className={BAR_BTN} onClick={onMarkRead}>
        标记已读
      </button>

      <MenuPrimitive.Root>
        <MenuPrimitive.Trigger
          render={
            <button type="button" className={BAR_BTN}>
              标记状态
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          }
        />
        <MenuPrimitive.Portal>
          <MenuPrimitive.Positioner align="start" alignOffset={0} sideOffset={4} className="isolate z-50">
            <MenuPrimitive.Popup className="z-50 min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
              {(Object.keys(STATUS_LABELS) as ReadingStatus[]).map((s) => (
                <MenuPrimitive.Item
                  key={s}
                  className={MENU_ITEM_CLASS}
                  onClick={() => onSetStatus(s)}
                >
                  {STATUS_LABELS[s]}
                </MenuPrimitive.Item>
              ))}
            </MenuPrimitive.Popup>
          </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
      </MenuPrimitive.Root>

      <button type="button" className={BAR_BTN} onClick={onPickFolder}>
        <FolderPlus className="h-4 w-4" />
        添加到文件夹
      </button>

      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md bg-[rgba(239,68,68,0.2)] px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-[rgba(239,68,68,0.3)]"
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
        删除
      </button>

      {/* 右区：关闭（清空选择） */}
      <button
        type="button"
        title="清空选择"
        aria-label="清空选择"
        onClick={onClose}
        className="pressable ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
