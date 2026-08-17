import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { fmtDur } from "@/components/LiveClock";

interface Props {
  /** 已累计的思考文本 */
  text: string;
  /** 是否正在生成中（胶囊显示「AI 思考中…」+ 实时计时） */
  streaming: boolean;
}

/**
 * 「思考」区：思考链胶囊，**默认收纳**。
 * - 生成中：胶囊与展开头部共用**同一个计时器**（每秒跳动，DSH `TurnStatus` 同款），
 *   显示「AI 思考中… Ns」，让用户清晰看到 AI 正在思考。
 * - 完成后：仅显示「已深度思考」（**不再显示时间**）；思考内容不持久化，
 *   仅本次会话内可展开回顾；总耗时由回答下方的 TimingLine 记录。
 */
export function ThinkingPanel({ text, streaming }: Props) {
  const [open, setOpen] = useState(false); // 默认收纳
  const [elapsedMs, setElapsedMs] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // 生成中：单一计时器，从思考开始每秒跳动（展开/收起不影响）
  useEffect(() => {
    if (!streaming) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  // 展开状态下生成中自动滚底
  useEffect(() => {
    if (open && streaming) {
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }
  }, [text, open, streaming]);

  if (!text) return null;

  return (
    <div className="flex w-full flex-col items-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pressable inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <Brain className="h-3 w-3" />
        {streaming ? (
          <span>
            AI 思考中…{" "}
            <span className="tabular-nums">{fmtDur(Math.floor(elapsedMs / 1000))}</span>
          </span>
        ) : (
          <span>已深度思考</span>
        )}
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
            {streaming && (
              <span className="ml-auto animate-pulse">
                生成中…{" "}
                <span className="tabular-nums">{fmtDur(Math.floor(elapsedMs / 1000))}</span>
              </span>
            )}
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
