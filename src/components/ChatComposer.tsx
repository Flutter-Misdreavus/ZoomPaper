import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder: string;
  controls: ReactNode;
}

/** Explicit sizing works in WKWebView as well as browsers without field-sizing. */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  sending,
  disabled,
  placeholder,
  controls,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "0px";
      element.style.height = `${Math.min(180, Math.max(48, element.scrollHeight))}px`;
      element.style.overflowY = element.scrollHeight > 180 ? "auto" : "hidden";
    };
    resize();
    // Observe width changes only, so height changes cannot cause a resize loop.
    let width = element.clientWidth;
    const widthObserver = new ResizeObserver(() => {
      if (width !== element.clientWidth) {
        width = element.clientWidth;
        resize();
      }
    });
    widthObserver.observe(element);
    return () => widthObserver.disconnect();
  }, [value]);
  return (
    <div className="chat-composer">
      <textarea
        ref={ref}
        aria-label="消息输入框"
        placeholder={placeholder}
        value={value}
        rows={2}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !composing.current &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault();
            if (!sending && !disabled && value.trim()) onSend();
          }
        }}
      />
      <div className="chat-composer-actions">
        <div className="chat-composer-options">{controls}</div>
        <button
          type="button"
          className="chat-send"
          aria-label={sending ? "停止生成" : "发送消息"}
          title={sending ? "停止生成" : "发送消息"}
          disabled={!sending && (disabled || !value.trim())}
          onClick={sending ? onStop : onSend}
        >
          {sending ? (
            <Square size={14} fill="currentColor" />
          ) : (
            <ArrowUp size={18} />
          )}
        </button>
      </div>
    </div>
  );
}
