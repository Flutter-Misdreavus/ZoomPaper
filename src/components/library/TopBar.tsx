/**
 * 顶部栏（TopBar）：标题 + 论文数量 + 搜索框 + 排序下拉 + 导入按钮。
 * 高度 64px（含 16px padding），底边 1px 边框。
 * 搜索为标题/作者即时过滤（纯客户端）；按 `/` 可聚焦搜索框。
 */
import { useEffect, useRef } from "react";
import { Loader2, Plus, Search as SearchIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  /** 搜索关键词（标题/作者即时过滤） */
  query: string;
  onQueryChange: (v: string) => void;
  onImport: () => void;
  importing: boolean;
}

export function TopBar({
  title,
  count,
  sortBy,
  onSortChange,
  query,
  onQueryChange,
  onImport,
  importing,
}: Props) {
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` 聚焦搜索框（键盘操作；中文输入态下 "/" 不会作为裸键到达）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [role='menu'], [role='dialog']")) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        {/* 搜索框：标题/作者即时过滤 */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-zp-quaternary" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="搜索论文…"
            aria-label="搜索论文"
            className="h-9 w-52 pl-8 pr-8"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => onQueryChange("")}
              className="pressable absolute top-1/2 right-2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-zp-quaternary transition-colors hover:bg-zp-surface-hover hover:text-zp-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

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
