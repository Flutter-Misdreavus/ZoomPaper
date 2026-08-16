import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

interface Props {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  /** 输入框宽度（px），默认 180 */
  width?: number;
}

/**
 * 访达式内联重命名：自动聚焦并全选，Enter 提交 / Esc 取消 / 失焦提交。
 */
export function RenameInput({ initialValue, onCommit, onCancel, width = 180 }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <Input
      ref={ref}
      defaultValue={initialValue}
      style={{ width }}
      className="h-6 px-1.5 text-sm font-medium"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          const v = (e.target as HTMLInputElement).value.trim();
          if (v) onCommit(v);
          else onCancel();
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v && v !== initialValue) onCommit(v);
        else onCancel();
      }}
    />
  );
}
