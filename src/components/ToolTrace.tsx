import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import type { ToolStep } from "@/lib/api";

/** 实时轨迹条目：ToolStep + 运行态（生成中）与单工具耗时 */
export type LiveToolStep = ToolStep & {
  running?: boolean;
  elapsed_ms?: number;
};

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

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** agent 深度模式的「工具调用轨迹」折叠条：工具名 + 参数 + 状态/摘要（错误红色） */
export function ToolTrace({ trace }: { trace?: LiveToolStep[] | null }) {
  const [open, setOpen] = useState(false);
  if (!trace || trace.length === 0) return null;
  const errors = trace.filter((t) => t.error).length;
  const running = trace.some((t) => t.running);

  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pressable inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Wrench className="h-3 w-3" />
        工具调用（{trace.length}）
        {running && <span className="text-primary">· 执行中</span>}
        {errors > 0 && <span className="text-destructive">· {errors} 个失败</span>}
      </button>
      {open && (
        <div className="mt-1.5 flex w-full flex-col gap-1 rounded-lg border bg-background/50 p-2">
          {trace.map((step, i) =>
            step.name === "quick_fallback" ? (
              // 回退提示：非工具调用，渲染为中性信息行
              <div
                key={i}
                className="rounded-md px-1.5 py-1 text-xs text-muted-foreground"
              >
                {step.summary}
              </div>
            ) : (
              <div key={i} className="rounded-md px-1.5 py-1 text-xs">
                <div className="flex items-baseline gap-1.5">
                  {step.running ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                  ) : null}
                  <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px]">
                    {step.name}
                  </code>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
                    {argsPreview(step.args)}
                  </span>
                  {step.running ? (
                    <span className="shrink-0 text-primary">
                      {step.elapsed_ms != null ? fmtMs(step.elapsed_ms) : "执行中"}
                    </span>
                  ) : step.error ? (
                    <span className="shrink-0 text-destructive">失败</span>
                  ) : (
                    step.summary && (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {step.summary}
                        {step.elapsed_ms != null && step.elapsed_ms > 0
                          ? ` · ${fmtMs(step.elapsed_ms)}`
                          : ""}
                      </span>
                    )
                  )}
                </div>
                {step.error && (
                  <p className="mt-0.5 line-clamp-2 break-words text-destructive/90">
                    {step.error}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
