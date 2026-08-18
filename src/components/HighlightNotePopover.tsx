import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check, Trash2, X } from "lucide-react";

interface Props {
  x: number;
  y: number;
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

/** 高亮笔记编辑弹层（博客/译文标注复用；PDF 保留自有实现） */
export function HighlightNotePopover({ x, y, initial, onSave, onCancel, onDelete }: Props) {
  const [draft, setDraft] = useState(initial);
  return (
    <div
      className="fixed z-50 w-72 rounded-lg border bg-popover p-3 shadow-lg"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 304)),
        top: Math.max(8, y),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="写下你的笔记…"
        className="min-h-20 text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-1.5">
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive"
            onClick={() => {
              onDelete?.();
              onCancel();
            }}
            title="删除该高亮"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
          >
            <X className="h-3 w-3" />
            取消
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onSave(draft)}
          >
            <Check className="h-3 w-3" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
