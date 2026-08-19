/**
 * 过滤标签栏（FilterBar）：pill 形状，与文件夹视图取交集。
 * 全部 / 未读 / 在读 / 已读 / 星标。
 */
import { cn } from "@/lib/utils";

export type PaperFilter = "all" | "unread" | "reading" | "read" | "starred";

export const FILTERS: { key: PaperFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "unread", label: "未读" },
  { key: "reading", label: "在读" },
  { key: "read", label: "已读" },
  { key: "starred", label: "星标" },
];

interface Props {
  value: PaperFilter;
  onChange: (v: PaperFilter) => void;
}

export function FilterBar({ value, onChange }: Props) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-4 pt-3">
      {FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => onChange(f.key)}
          className={cn(
            "rounded-md px-3 py-1 text-[13px] transition-colors",
            value === f.key
              ? "bg-zp-primary font-medium text-white"
              : "bg-transparent text-zp-tertiary hover:bg-zp-surface-hover hover:text-zp-primary"
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
