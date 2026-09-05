/**
 * 「加入阅读计划」子菜单：参考苹果提醒事项，加入时顺手定日期。
 * Menu 与 ContextMenu 两套 Base UI 原语 API 同构，由 PaperCard 各实例化一次，
 * 通过 PlanMenuPrimitives 注入具体组件，本文件只写一遍内容。
 */
import {
  CalendarArrowUp,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronRight,
  ListPlus,
} from "lucide-react";
import { cn, formatTime } from "@/lib/utils";
import type { ReadingPlan } from "@/lib/api";
import { MENU_ITEM_CLASS } from "./paperMenu";

/** Menu / ContextMenu 的同构子集（仅本子菜单用到的部分） */
export interface PlanMenuPrimitives {
  SubmenuRoot: React.ComponentType<{ children?: React.ReactNode }>;
  SubmenuTrigger: React.ComponentType<{
    className?: string;
    children?: React.ReactNode;
  }>;
  Portal: React.ComponentType<{ children?: React.ReactNode }>;
  Positioner: React.ComponentType<{
    className?: string;
    sideOffset?: number;
    children?: React.ReactNode;
  }>;
  Popup: React.ComponentType<{ className?: string; children?: React.ReactNode }>;
  Item: React.ComponentType<{
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
    closeOnClick?: boolean;
    children?: React.ReactNode;
  }>;
}

/** 子菜单弹层样式：与 PaperCard 的两个菜单 Popup 一致 */
const POPUP_CLASS =
  "z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/** 某天 23:59 的 epoch 秒 */
function endOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(23, 59, 59, 0);
  return Math.floor(x.getTime() / 1000);
}

/** 快捷日期选项（提醒事项式）：今天 / 明天 / 本周内（本周日 23:59，若今天周日则今天） */
export function quickDueOptions(): { key: string; label: string; ts: number }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const sunday = new Date(today);
  sunday.setDate(today.getDate() + ((7 - today.getDay()) % 7));
  return [
    { key: "today", label: "今天", ts: endOfDay(today) },
    { key: "tomorrow", label: "明天", ts: endOfDay(tomorrow) },
    { key: "week", label: "本周内", ts: endOfDay(sunday) },
  ];
}

export type DueTone = "red" | "amber" | "muted";

/** 条目截止日期的展示徽章：已逾期红 / 今天或 ≤3 天（未读）橙 / 其余灰；已读一律灰 */
export function dueBadge(
  due: number | null,
  read: boolean,
): { text: string; tone: DueTone } | null {
  if (due == null) return null;
  const now = Date.now() / 1000;
  if (!read && due < now) return { text: "已逾期", tone: "red" };
  const todayEnd = endOfDay(new Date());
  if (due <= todayEnd) return { text: "今天", tone: read ? "muted" : "amber" };
  if (due <= todayEnd + 86400) return { text: "明天", tone: read ? "muted" : "amber" };
  const days = Math.ceil((due - now) / 86400);
  const near = !read && days <= 3;
  return { text: `还剩 ${days} 天`, tone: near ? "amber" : "muted" };
}

/** 指派计划的自动命名（计划没有用户可编辑的名称）：清单（N 篇 · M月D日建） */
export function planLabel(plan: ReadingPlan): string {
  const created = new Date(plan.created_at * 1000).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
  return `清单（${plan.items.length} 篇 · ${created}建）`;
}

const DUE_ICONS = {
  today: CalendarDays,
  tomorrow: CalendarArrowUp,
  week: CalendarRange,
} as const;

interface PlanSubmenuProps {
  P: PlanMenuPrimitives;
  /** 进行中的指派论文计划（用于选择目标） */
  activePlans: ReadingPlan[];
  /** 论文当前所在的计划（null = 未加入任何计划） */
  containingPlan: ReadingPlan | null;
  /** 当前条目的截止日期（仅已加入时有值） */
  currentDue: number | null;
  /** 当前生效的目标计划 id */
  targetPlanId: string | null;
  onSelectTarget: (planId: string) => void;
  /** 快捷日期 / 更新日期（due 为 null 表示无日期） */
  onQuickDate: (dueTs: number | null) => void;
  onCustomDate: () => void;
  /** 仅已加入时提供：从计划移除 */
  onRemove: (() => void) | null;
}

export function PlanSubmenu({
  P,
  activePlans,
  containingPlan,
  currentDue,
  targetPlanId,
  onSelectTarget,
  onQuickDate,
  onCustomDate,
  onRemove,
}: PlanSubmenuProps) {
  const showPlanPicker = !containingPlan && activePlans.length > 1;
  return (
    <P.SubmenuRoot>
      <P.SubmenuTrigger className={cn(MENU_ITEM_CLASS, "justify-between")}>
        <span className="flex items-center gap-2">
          <ListPlus className="h-4 w-4 text-muted-foreground" />
          {containingPlan ? "阅读计划" : "加入阅读计划"}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      </P.SubmenuTrigger>
      <P.Portal>
        <P.Positioner sideOffset={2} className="isolate z-50">
          <P.Popup className={POPUP_CLASS}>
            {containingPlan && (
              <>
                <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                  已加入计划
                  {currentDue != null
                    ? ` · 截止 ${formatTime(currentDue)}`
                    : " · 无日期"}
                </div>
                <div className="my-1 h-px bg-border" />
              </>
            )}

            {showPlanPicker && (
              <>
                <div className="px-2.5 py-1 text-xs text-muted-foreground">
                  加入目标
                </div>
                {activePlans.map((p) => (
                  <P.Item
                    key={p.id}
                    closeOnClick={false}
                    className={MENU_ITEM_CLASS}
                    onClick={() => onSelectTarget(p.id)}
                  >
                    <Check
                      className={cn(
                        "h-4 w-4",
                        p.id === targetPlanId ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {planLabel(p)}
                  </P.Item>
                ))}
                <div className="my-1 h-px bg-border" />
              </>
            )}

            {quickDueOptions().map((opt) => {
              const Icon = DUE_ICONS[opt.key as keyof typeof DUE_ICONS];
              return (
                <P.Item
                  key={opt.key}
                  className={MENU_ITEM_CLASS}
                  onClick={() => onQuickDate(opt.ts)}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {opt.label}
                </P.Item>
              );
            })}
            <P.Item className={MENU_ITEM_CLASS} onClick={onCustomDate}>
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              自定义日期…
            </P.Item>

            {containingPlan && onRemove && (
              <>
                <div className="my-1 h-px bg-border" />
                <P.Item
                  className={cn(
                    MENU_ITEM_CLASS,
                    "text-destructive data-[highlighted]:bg-destructive/10",
                  )}
                  onClick={onRemove}
                >
                  从计划移除
                </P.Item>
              </>
            )}
          </P.Popup>
        </P.Positioner>
      </P.Portal>
    </P.SubmenuRoot>
  );
}
