/**
 * 顶部栏（TopBar）：标题 + 论文数量 + 排序下拉 + 导入按钮。
 * 高度 64px（含 16px padding），底边 1px 边框。
 */
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SortBy = "created" | "title" | "read";

const SORT_LABELS: Record<SortBy, string> = {
  read: "最近阅读",
  created: "添加时间",
  title: "标题",
};

interface Props {
  title: string;
  count: number;
  sortBy: SortBy;
  onSortChange: (v: SortBy) => void;
  onImport: () => void;
  importing: boolean;
}

export function TopBar({ title, count, sortBy, onSortChange, onImport, importing }: Props) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-zp-border px-4">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-[20px] leading-[1.3] font-medium text-zp-primary">
          {title}
        </h1>
        <span className="shrink-0 text-[13px] tabular-nums text-zp-quaternary">
          {count} 篇
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Select value={sortBy} onValueChange={(v) => onSortChange(v as SortBy)}>
          <SelectTrigger className="h-9 w-32" aria-label="排序方式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
              <SelectItem key={k} value={k}>
                {SORT_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={onImport}
          disabled={importing}
          className="bg-zp-primary text-white hover:bg-zp-primary/90"
        >
          {importing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          导入论文
        </Button>
      </div>
    </header>
  );
}
