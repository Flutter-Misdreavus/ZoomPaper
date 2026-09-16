/**
 * 批量操作栏（BulkBar）：选中 ≥1 篇论文时浮现。
 * 浅色磨砂浮动工具条：材质最轻 → 次级按钮（灰阶）→ 仅「标记已读」一个深色主按钮，
 * 删除为红字浅红底。入场 200ms ease-out（opacity + scale），退出由外层 AnimatePresence 控制。
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { motion, useReducedMotion } from "motion/react";
import { ChevronDown, FolderPlus, Trash2, X } from "lucide-react";
import type { ReadingStatus } from "@/lib/api";

/** 次级按钮：灰阶 ghost，hover 浮起 */
const BAR_BTN =
  "pressable flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] text-zp-secondary transition-colors hover:bg-zp-surface-hover hover:text-zp-primary";

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
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={{
        opacity: 0,
        y: reduceMotion ? 0 : -6,
        scale: reduceMotion ? 1 : 0.98,
      }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{
        opacity: 0,
        y: reduceMotion ? 0 : -4,
        transition: { duration: 0.15, ease: [0.23, 1, 0.32, 1] },
      }}
      transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
      className="zp-bulk-bar mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-xl border border-zp-border bg-white px-5 py-2 shadow-md shadow-black/5 backdrop-blur-xl supports-[backdrop-filter]:bg-white/75 dark:bg-zp-surface/80"
    >
      {/* 左区：计数 */}
      <span className="mr-1 shrink-0 text-sm font-medium text-zp-primary tabular-nums">
        {count} 篇已选
      </span>
      <span className="h-4 w-px shrink-0 bg-zp-border" aria-hidden />

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

      {/* 删除：红字浅红底（危险可见但不过重） */}
      <button
        type="button"
        className="pressable flex items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-[13px] text-red-600 transition-colors hover:bg-red-500/15 dark:text-red-400"
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
        className="pressable ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zp-quaternary transition-colors hover:bg-zp-surface-hover hover:text-zp-primary"
      >
        <X className="h-4 w-4" />
      </button>
    </motion.div>
  );
}
