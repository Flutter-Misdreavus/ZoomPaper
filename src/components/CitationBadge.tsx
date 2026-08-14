import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Citation } from "@/lib/api";
import { ExternalLink, FileSearch } from "lucide-react";

interface Props {
  index: number;
  citation: Citation | undefined;
  /** 单篇阅读场景：PDF 内跳页（0-based） */
  onJumpPage?: (pageIdx: number) => void;
  /** 跨论文问答场景：跳转到来源论文（可带页码） */
  onOpenPaper?: (paperId: string, pageIdx?: number) => void;
}

/** 回答正文中的 [n] 引用徽标，点击弹出原文出处 */
export function CitationBadge({ index, citation, onJumpPage, onOpenPaper }: Props) {
  if (!citation) {
    return <sup className="text-muted-foreground">[{index}]</sup>;
  }
  return (
    <Popover>
      <PopoverTrigger
        className="pressable mx-0.5 inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-sm bg-primary/10 px-1 align-super text-[10px] font-semibold text-primary transition-colors hover:bg-primary/20"
        aria-label={`引用 ${index}`}
      >
        {index}
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{citation.paper_title}</span>
            {onJumpPage && citation.page_idx != null && (
              <button
                onClick={() => onJumpPage(citation.page_idx!)}
                className="pressable inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
              >
                <FileSearch className="h-3 w-3" />
                跳到第 {citation.page_idx + 1} 页
              </button>
            )}
            {!onJumpPage && onOpenPaper && (
              <button
                onClick={() => onOpenPaper(citation.paper_id, citation.page_idx ?? undefined)}
                className="pressable inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                打开论文
              </button>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {citation.section}
            {citation.page_idx != null && ` · 第 ${citation.page_idx + 1} 页`}
          </div>
          <p className="line-clamp-6 text-xs leading-relaxed text-muted-foreground">
            {citation.snippet}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
