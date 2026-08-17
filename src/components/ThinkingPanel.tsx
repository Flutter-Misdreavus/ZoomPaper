import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

interface Props {
  /** 已累计的思考文本 */
  text: string;
  /** 是否正在生成中（生成中自动展开并滚底） */
  streaming: boolean;
}

/** AI 思考过程面板：生成中实时滚动显示；完成后折叠为可展开小结。思考内容不持久化。 */
export function ThinkingPanel({ text, streaming }: Props) {
  const [open, setOpen] = useState(streaming);
  const ref = useRef<HTMLDivElement>(null);

  // 生成中自动展开
  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  // 生成中自动滚底
  useEffect(() => {
    if (open && streaming) {
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }
  }, [text, open, streaming]);

  if (!text) return null;

  const charCount = text.length;
  return (
    <div className="mt-2 max-w-[85%]">
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
        <Brain className="h-3 w-3" />
        {streaming ? "AI 思考中…" : `思考过程（${charCount} 字）`}
      </button>
      {open && (
        <div
          ref={ref}
          className="mt-1.5 max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-background/50 p-2.5 text-xs leading-relaxed text-muted-foreground"
        >
          {text}
          {streaming && <span className="animate-pulse">▍</span>}
        </div>
      )}
    </div>
  );
}
