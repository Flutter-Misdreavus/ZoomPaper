import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

interface Props {
  /** 已累计的思考文本 */
  text: string;
  /** 是否正在生成中（胶囊显示「AI 思考中…」） */
  streaming: boolean;
  /** 完成后的思考耗时（ms），用于「已深度思考（用时 X 秒）」标签 */
  durationMs?: number;
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`;
}

/**
 * 「思考」区：思考链胶囊，**默认收纳**——生成中显示「AI 思考中…」、
 * 完成后显示「已深度思考（用时 X 秒）」；展开后为带「思考」区块头的滚动文本块。
 * 思考内容不持久化，仅本次会话内可回顾。
 */
export function ThinkingPanel({ text, streaming, durationMs }: Props) {
  const [open, setOpen] = useState(false); // 默认收纳
  const ref = useRef<HTMLDivElement>(null);

  // 展开状态下生成中自动滚底
  useEffect(() => {
    if (open && streaming) {
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }
  }, [text, open, streaming]);

  if (!text) return null;

  const label = streaming
    ? "AI 思考中…"
    : durationMs != null && durationMs > 0
      ? `已深度思考（用时 ${fmtDuration(durationMs)}）`
      : `思考过程（${text.length} 字）`;

  return (
    <div className="flex w-full flex-col items-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pressable inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <Brain className="h-3 w-3" />
        <span>{label}</span>
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {open && (
        <div className="mt-1.5 w-full overflow-hidden rounded-lg border bg-muted/30">
          <div className="flex items-center gap-1 border-b bg-muted/40 px-2.5 py-1 text-[10px] text-muted-foreground/80">
            <Brain className="h-3 w-3" />
            思考
            {streaming && <span className="ml-auto animate-pulse">生成中…</span>}
          </div>
          <div
            ref={ref}
            className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
          >
            {text}
            {streaming && <span className="animate-pulse">▍</span>}
          </div>
        </div>
      )}
    </div>
  );
}
