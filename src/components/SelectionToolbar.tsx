import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Copy, MessageSquare, StickyNote } from "lucide-react";

/** 高亮色板（rgba，叠在白底/浅色内容上） */
export const HIGHLIGHT_COLORS = [
  { name: "黄", color: "rgba(255,213,0,.45)" },
  { name: "绿", color: "rgba(0,200,83,.35)" },
  { name: "蓝", color: "rgba(64,156,255,.32)" },
  { name: "粉", color: "rgba(255,64,129,.32)" },
];

interface Props {
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
export function SelectionToolbar({ x, y, onHighlight, onNote, onAsk, onCopy }: Props) {
  return (
    <div
      className="fixed z-50 flex items-center gap-1 rounded-lg border bg-popover px-1.5 py-1 shadow-lg select-none"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.name}
          title={`高亮：${c.name}`}
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
  );
}
