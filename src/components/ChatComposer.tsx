import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendHorizonal, Square } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 提交（Enter 或点击发送）；内部已处理 IME 组合输入 */
  onSend: () => void;
  /** 生成中：发送钮变为暂停钮 */
  sending?: boolean;
  onStop?: () => void;
  /** 发送禁用（如输入为空）；暂停钮不受此影响 */
  sendDisabled?: boolean;
  /** 整个输入框禁用（如旧版会话只读） */
  disabled?: boolean;
  placeholder?: string;
  /** 顶部附件区（引用 chips 等），无边框分隔 */
  attachments?: ReactNode;
  /** 底部工具行左侧（模式开关 / 联网 / 出题等） */
  left?: ReactNode;
  /** 底部工具行右侧、发送钮之前的额外动作 */
  rightExtra?: ReactNode;
}

/**
 * 对话输入壳（问答/费曼共用）：圆角卡片容器 + 无边框 Textarea + 底部工具行。
 * 聚焦时边框与 ring 微强化；发送/暂停为圆形按钮。Enter 发送、Shift+Enter 换行。
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  sending,
  onStop,
  sendDisabled,
  disabled,
  placeholder,
  attachments,
  left,
  rightExtra,
}: Props) {
  return (
    <div className="rounded-2xl border bg-card transition-[border-color,box-shadow] focus-within:border-foreground/25 focus-within:ring-2 focus-within:ring-ring/15">
      {attachments}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={placeholder}
        rows={1}
        className="min-h-11 flex-1 resize-none rounded-none border-0 bg-transparent px-3.5 py-3 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{left}</div>
        {rightExtra}
        {sending ? (
          <Button
            size="icon"
            variant="outline"
            onClick={onStop}
            title="暂停生成"
            className="pressable h-8 w-8 shrink-0 rounded-full"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={onSend}
            disabled={sendDisabled}
            title="发送"
            className="pressable h-8 w-8 shrink-0 rounded-full"
          >
            <SendHorizonal className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
