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
 * AI 思考链胶囊：**默认收纳**，形式同网页版 AI 对话——生成中显示「AI 思考中…」、
 * 完成后显示「已深度思考（用时 X 秒）」，点击展开查看思考内容。
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
    <div className="flex flex-col items-start">
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
        <div
          ref={ref}
          className="mt-1.5 max-h-[40vh] w-full max-w-[85%] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-background/50 p-2.5 text-xs leading-relaxed text-muted-foreground"
        >
          {text}
          {streaming && <span className="animate-pulse">▍</span>}
        </div>
      )}
    </div>
  );
}
