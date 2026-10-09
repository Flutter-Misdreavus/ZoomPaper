import { RotateCcw, Trash2 } from "lucide-react";
import type { Paper } from "@/lib/api";
import { displayPaperTitle, formatTime } from "@/lib/utils";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { VenueBadge } from "./VenueBadge";

export function TrashList({ papers, onRestore, onDelete }: {
  papers: Paper[];
  onRestore: (paper: Paper) => void;
  onDelete: (paper: Paper) => void;
}) {
  return (
    <div className="min-w-[620px] bg-white text-[13px] dark:bg-zp-surface">
      <div className="grid h-9 grid-cols-[minmax(320px,1fr)_180px_84px] items-center border-b border-zp-border px-4 text-xs text-zp-quaternary">
        <span>标题</span><span>删除时间</span><span />
      </div>
      {papers.map((paper) => (
        <div key={paper.id} className="group grid min-h-12 grid-cols-[minmax(320px,1fr)_180px_84px] items-center border-b border-zp-border/70 px-4 hover:bg-zp-surface-hover">
          <div className="flex min-w-0 items-center gap-2.5 pr-4">
            <VenueBadge venue={paper.venue} sourceUrl={paper.source_url} iconUrl={paper.source_icon_url} compact />
            <span className="truncate font-medium text-zp-primary">{displayPaperTitle(paper.title)}</span>
          </div>
          <span className="text-xs text-zp-quaternary">{paper.deleted_at ? formatTime(paper.deleted_at) : "—"}</span>
          <div className="flex justify-end gap-1">
            <IconTooltip label="恢复论文"><button type="button" aria-label="恢复论文" onClick={() => onRestore(paper)} className="flex h-7 w-7 items-center justify-center rounded-md text-zp-tertiary hover:bg-white hover:text-zp-primary dark:hover:bg-zp-surface"><RotateCcw className="h-4 w-4" /></button></IconTooltip>
            <IconTooltip label="永久删除"><button type="button" aria-label="永久删除" onClick={() => onDelete(paper)} className="flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button></IconTooltip>
          </div>
        </div>
      ))}
    </div>
  );
}
