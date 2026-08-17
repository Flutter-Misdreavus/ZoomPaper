import { Globe } from "lucide-react";

interface Props {
  /** 当前开关状态 */
  on: boolean;
  onChange: (v: boolean) => void;
  /** 是否已配置搜索 provider（未配置时开关旁显示「未配置」提示） */
  configured: boolean;
  disabled?: boolean;
}

/** 联网搜索开关（pill 样式）：对话页与费曼窗口共用 */
export function WebToggle({ on, onChange, configured, disabled }: Props) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(!on)}
        disabled={disabled}
        title={on ? "关闭联网搜索" : "开启联网搜索"}
        className={`pressable inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
          on
            ? "border-primary/40 bg-primary/10 font-medium text-primary"
            : "bg-muted/60 text-muted-foreground hover:text-foreground"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <Globe className="h-3 w-3" />
        联网
      </button>
      {on && !configured && (
        <span
          className="text-[11px] text-amber-600/90"
          title="请在设置页选择搜索 Provider（自动/DeepSeek/Anthropic）并确保对应 API Key 已填写"
        >
          未配置
        </span>
      )}
    </div>
  );
}
