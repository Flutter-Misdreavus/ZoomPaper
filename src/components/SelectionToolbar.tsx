import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { translateSelection } from "@/lib/api";
import {
  Copy,
  MessageSquare,
  StickyNote,
  Languages,
  Loader2,
  X,
} from "lucide-react";

/** 高亮色板（rgba，叠在白底/浅色内容上） */
export const HIGHLIGHT_COLORS = [
  { name: "黄", color: "rgba(255,213,0,.45)" },
  { name: "绿", color: "rgba(0,200,83,.35)" },
  { name: "蓝", color: "rgba(64,156,255,.32)" },
  { name: "粉", color: "rgba(255,64,129,.32)" },
];

interface Props {
  text: string;
  x: number;
  y: number;
  /** 选色高亮 */
  onHighlight: (color: string) => void;
  /** 笔记（通常 = 默认色高亮 + 打开笔记编辑） */
  onNote: () => void;
  /** 提问（PDF 阅读页 / 博客 / 译文视图可用） */
  onAsk?: () => void;
  onCopy: () => void;
}

/** 划选后的浮动工具条：4 色高亮 / 提问 / 笔记 / 复制（PDF 原文与博客/译文共用） */
export function SelectionToolbar({
  text,
  x,
  y,
  onHighlight,
  onNote,
  onAsk,
  onCopy,
}: Props) {
  const [translation, setTranslation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useEffect(() => {
    request.current++;
    setTranslation(null);
    setError(null);
    setLoading(false);
    setExpanded(false);
    return () => {
      request.current++;
    };
  }, [text, x, y]);
  useLayoutEffect(() => {
    const place = () => {
      const rect = panel.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
          top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
        });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [x, y, expanded, loading, translation, error]);
  async function translate() {
    setExpanded(true);
    if (loading || translation) return;
    if ([...text.trim()].length > 2000) {
      setError("选中文字过长，请缩小到 2000 字以内。");
      return;
    }
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const selection = window.getSelection();
      const node = selection?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      const surrounding =
        element?.closest(".textLayer, p, li, blockquote")?.textContent ?? "";
      const start = Math.max(0, surrounding.indexOf(text.trim()) - 300);
      const context = surrounding.slice(start, start + 1000);
      const result = await translateSelection(text.trim(), context);
      if (request.current === id) setTranslation(result);
    } catch (e) {
      if (request.current === id)
        setError(`翻译失败，请检查设置中的 AI 配置后重试。${String(e)}`);
    } finally {
      if (request.current === id) setLoading(false);
    }
  }
  return (
    <div
      ref={panel}
      data-selection-toolbar
      className="fixed z-50 max-w-[calc(100vw-16px)] rounded-xl border bg-popover p-2 shadow-xl select-none"
      style={position}
      onMouseDown={(e) => e.preventDefault()}
      onMouseUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") setExpanded(false);
      }}
    >
      <div
        className="flex flex-wrap items-center gap-1"
        role="toolbar"
        aria-label="选中文字操作"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs text-primary"
          onClick={() => void translate()}
        >
          <Languages className="h-3.5 w-3.5" />
          速译
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4" />
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.name}
            title={`高亮：${c.name}`}
            aria-label={`高亮：${c.name}`}
            className="h-5 w-5 rounded-full ring-1 ring-black/15 transition-transform hover:scale-110"
            style={{ background: c.color }}
            onClick={() => onHighlight(c.color)}
          />
        ))}
        <Separator orientation="vertical" className="mx-0.5 h-4" />
        {onAsk && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={onAsk}
          >
            <MessageSquare className="h-3 w-3" />
            提问
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={onNote}
        >
          <StickyNote className="h-3 w-3" />
          笔记
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={onCopy}
        >
          <Copy className="h-3 w-3" />
          复制
        </Button>
      </div>
      {expanded && (
        <div className="mt-2 w-80 max-w-full border-t pt-3" aria-live="polite">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>中文释义</span>
            <button
              aria-label="收起翻译"
              onClick={() => setExpanded(false)}
              className="rounded p-1 hover:bg-accent"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {loading ? (
            <p className="flex items-center gap-2 pb-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在翻译…
            </p>
          ) : error ? (
            <div className="text-xs text-destructive">
              <p className="max-h-24 overflow-auto break-words">{error}</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void translate()}
              >
                重试
              </Button>
            </div>
          ) : (
            <p className="max-h-48 overflow-auto break-words pb-2 text-sm leading-7">
              {translation}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
