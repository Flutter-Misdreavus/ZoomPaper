import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ToolStep } from "@/lib/api";

/** 把工具参数压成短预览文本（截断） */
function argsPreview(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    if (!s) return "";
    return s.length > 72 ? `${s.slice(0, 72)}…` : s;
  } catch {
    return "";
  }
}

/** agent 深度模式的「工具调用轨迹」折叠条：工具名 + 参数 + 结果摘要（错误红色） */
export function ToolTrace({ trace }: { trace?: ToolStep[] | null }) {
  const [open, setOpen] = useState(false);
  if (!trace || trace.length === 0) return null;
  const errors = trace.filter((t) => t.error).length;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pressable inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Wrench className="h-3 w-3" />
        工具调用（{trace.length}）
        {errors > 0 && <span className="text-destructive">· {errors} 个失败</span>}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1 rounded-lg border bg-background/50 p-2">
          {trace.map((step, i) => (
            <div key={i} className="rounded-md px-1.5 py-1 text-xs">
              <div className="flex items-baseline gap-1.5">
                <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px]">
                  {step.name}
                </code>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
                  {argsPreview(step.args)}
                </span>
                {step.error ? (
                  <span className="shrink-0 text-destructive">失败</span>
                ) : (
                  step.summary && (
                    <span className="shrink-0 text-muted-foreground">{step.summary}</span>
                  )
                )}
              </div>
              {step.error && (
                <p className="mt-0.5 line-clamp-2 text-destructive/90">{step.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
