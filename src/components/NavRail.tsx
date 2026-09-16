/**
 * 左侧导航栏（NavRail）：56px 图标导航，黑白灰体系。
 * 当前项以左侧 3px 竖线标识（非背景块）；hover 时图标变 primary。
 */
import {
  BookOpen,
  CalendarDays,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type NavItem = "library" | "timeline" | "search" | "ask" | "settings";

const NAV_ITEMS: { name: NavItem; label: string; icon: typeof BookOpen }[] = [
  { name: "library", label: "论文库", icon: BookOpen },
  { name: "timeline", label: "时间线", icon: CalendarDays },
  { name: "search", label: "搜索", icon: Search },
  { name: "ask", label: "问答", icon: MessageSquare },
  { name: "settings", label: "设置", icon: SettingsIcon },
];

interface Props {
  active: NavItem;
  onSelect: (name: NavItem) => void;
}

export function NavRail({ active, onSelect }: Props) {
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center border-r border-zp-border py-4">
      {/* Logo：32×32 圆角矩形，深色填充 + 白色首字母 */}
      <div className="mb-6 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-zp-primary text-sm font-semibold text-white">
        Z
      </div>
      <div className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.name;
          return (
            <button
              key={item.name}
              type="button"
              title={item.label}
              aria-label={item.label}
              onClick={() => onSelect(item.name)}
              className={cn(
                "pressable relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                isActive
                  ? "text-zp-primary"
                  : "text-zp-tertiary hover:bg-zp-surface-hover hover:text-zp-primary"
              )}
            >
              {isActive && (
                <span className="absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-sm bg-zp-primary" />
              )}
              <Icon className="h-5 w-5" strokeWidth={1.8} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
