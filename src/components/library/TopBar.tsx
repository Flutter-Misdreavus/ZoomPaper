/**
 * 顶部栏（TopBar）：标题 + 论文数量 + 搜索框 + 排序下拉 + 导入按钮。
 * 高度 64px（含 16px padding），底边 1px 边框。
 * 搜索为标题/作者/摘要即时过滤（纯客户端）；按 `/` 或 ⌘/Ctrl F 可聚焦搜索框。
 */
import { useEffect, useRef } from "react";
import { LayoutGrid, List, ListChecks, Loader2, Search as SearchIcon, Trash2, Upload, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { PaperFilter } from "./FilterBar";

export type SortBy = "created" | "title" | "read";
export type LibraryLayout = "list" | "grid";

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
  /** 搜索关键词（标题/作者/摘要即时过滤） */
  query: string;
  onQueryChange: (v: string) => void;
  onImport: () => void;
  importing: boolean;
  filter: PaperFilter;
  onFilterChange: (filter: PaperFilter) => void;
  layout: LibraryLayout;
  onLayoutChange: (layout: LibraryLayout) => void;
  selectionMode: boolean;
  onToggleSelectionMode: () => void;
  trashMode?: boolean;
  onEmptyTrash?: () => void;
}

const FILTER_LABELS: Record<PaperFilter, string> = {
  all: "全部",
  unread: "未读",
  reading: "在读",
  read: "已读",
  starred: "星标",
};

export function TopBar({
  title,
  count,
  sortBy,
  onSortChange,
  query,
  onQueryChange,
  onImport,
  importing,
  filter,
  onFilterChange,
  layout,
  onLayoutChange,
  selectionMode,
  onToggleSelectionMode,
  trashMode = false,
  onEmptyTrash,
}: Props) {
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` 聚焦搜索框（键盘操作；中文输入态下 "/" 不会作为裸键到达）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isShortcut = e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f");
      if (!isShortcut) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [role='menu'], [role='dialog']")) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zp-border bg-white px-3 dark:bg-zp-surface">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-[17px] leading-[1.3] font-medium text-zp-primary">
          {title}
        </h1>
        <span className="shrink-0 text-[13px] tabular-nums text-zp-quaternary">
          {count} 篇
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {trashMode && (
          <button type="button" onClick={onEmptyTrash} disabled={!onEmptyTrash} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-40">
            <Trash2 className="h-3.5 w-3.5" />
            清空回收站
          </button>
        )}
        {/* 搜索框：标题/作者即时过滤 */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-zp-quaternary" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder=""
            aria-label="搜索论文"
            className="h-8 w-36 rounded-md border-zp-border bg-zp-surface pl-8 pr-8 shadow-none min-[1100px]:w-64"
          />
          {query && (
            <IconTooltip label="清空搜索" className="absolute top-1/2 right-2 -translate-y-1/2">
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => onQueryChange("")}
              className="pressable flex h-5 w-5 items-center justify-center rounded-full text-zp-quaternary transition-colors hover:bg-zp-surface-hover hover:text-zp-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            </IconTooltip>
          )}
        </div>

        {!trashMode && <Select value={filter} onValueChange={(v) => onFilterChange(v as PaperFilter)}>
          <SelectTrigger className="h-8 w-24 border-zp-border shadow-none" aria-label="筛选论文">
            <span className="flex-1 text-left">{FILTER_LABELS[filter]}</span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FILTER_LABELS) as PaperFilter[]).map((key) => <SelectItem key={key} value={key}>{FILTER_LABELS[key]}</SelectItem>)}
          </SelectContent>
        </Select>}
        <Select value={sortBy} onValueChange={(v) => onSortChange(v as SortBy)}>
          <SelectTrigger className="h-8 w-32 border-zp-border shadow-none" aria-label="排序方式">
            <span className="flex-1 text-left">{SORT_LABELS[sortBy]}</span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
              <SelectItem key={k} value={k}>
                {SORT_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center rounded-md border border-zp-border bg-zp-surface p-0.5">
          <IconTooltip label="列表视图"><button type="button" aria-label="列表视图" onClick={() => onLayoutChange("list")} className={`flex h-6 w-7 items-center justify-center rounded ${layout === "list" ? "bg-white text-zp-primary shadow-sm dark:bg-zp-surface-active" : "text-zp-quaternary"}`}><List className="h-3.5 w-3.5" /></button></IconTooltip>
          <IconTooltip label="卡片视图"><button type="button" aria-label="卡片视图" onClick={() => onLayoutChange("grid")} className={`flex h-6 w-7 items-center justify-center rounded ${layout === "grid" ? "bg-white text-zp-primary shadow-sm dark:bg-zp-surface-active" : "text-zp-quaternary"}`}><LayoutGrid className="h-3.5 w-3.5" /></button></IconTooltip>
        </div>
        {!trashMode && <IconTooltip label={selectionMode ? "退出多选（Esc）" : "多选论文（也可长按论文）"}>
          <button type="button" aria-label={selectionMode ? "退出多选" : "多选论文"} aria-pressed={selectionMode} onClick={onToggleSelectionMode} className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${selectionMode ? "bg-zp-primary text-white" : "text-zp-quaternary hover:bg-zp-surface-hover hover:text-zp-primary"}`}><ListChecks className="h-4 w-4" /></button>
        </IconTooltip>}
        {!trashMode && <IconTooltip label={importing ? "正在导入论文" : "导入论文"}><button type="button" onClick={onImport} disabled={importing} aria-label="导入论文" className="flex h-8 w-8 items-center justify-center rounded-md bg-zp-primary text-white transition-opacity hover:opacity-90 disabled:opacity-50">
          {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        </button></IconTooltip>}
      </div>
    </header>
  );
}
