import { ArrowLeft, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import type { ReaderTab } from "@/lib/readerTabs";
import { cn } from "@/lib/utils";

interface Props {
  tabs: ReaderTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onBack: () => void;
}

/** 阅读页顶部标签条：仿浏览器标签，可切换/关闭，左端固定返回论文库 */
export function ReaderTabBar({ tabs, activeTabId, onActivate, onClose, onBack }: Props) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border pb-1">
      <IconTooltip label="返回论文库（保留标签）" side="bottom">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="返回论文库"
          className="pressable h-8 w-8 shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </IconTooltip>
      <div
        role="tablist"
        aria-label="阅读标签"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              title={tab.title}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab.id);
              }}
              className={cn(
                "group flex h-8 max-w-48 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm select-none",
                active
                  ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
              <span className="min-w-0 truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted-foreground/20",
                  active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
