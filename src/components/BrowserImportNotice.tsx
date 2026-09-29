import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, X } from "lucide-react";

export type BrowserImportPhase = "downloading" | "parsing" | "done" | "warning" | "error";

interface Props {
  phase: BrowserImportPhase;
  title: string;
  message: string;
  onClose: () => void;
}

export function BrowserImportNotice({ phase, title, message, onClose }: Props) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busy = phase === "downloading" || phase === "parsing";
  const Icon = busy ? Loader2 : phase === "done" ? CheckCircle2 : AlertTriangle;
  const iconClass = phase === "done"
    ? "text-emerald-600"
    : phase === "error" || phase === "warning"
      ? "text-amber-600"
      : "text-primary";

  useEffect(() => {
    if (phase !== "done") return;
    const timer = window.setTimeout(() => onCloseRef.current(), 5000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <aside
      role={phase === "error" ? "alert" : "status"}
      aria-live="polite"
      className="fixed right-5 top-5 z-[100] w-[min(390px,calc(100vw-40px))] rounded-2xl border border-border/80 bg-background/95 p-4 shadow-xl shadow-black/10 backdrop-blur"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-muted p-2">
          <Icon className={`size-5 ${iconClass} ${busy ? "animate-spin" : ""}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {busy && <Download className="size-3.5 text-muted-foreground" />}
            {phase === "downloading" ? "正在从浏览器导入" : phase === "parsing" ? "正在解析论文" : phase === "done" ? "已加入论文库" : phase === "warning" ? "已导入，解析未完成" : "导入失败"}
          </div>
          <p className="mt-1 truncate text-sm text-foreground" title={title}>{title}</p>
          {message && <p className="mt-1 text-xs leading-5 text-muted-foreground">{message}</p>}
        </div>
        {!busy && (
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="关闭提示">
            <X className="size-4" />
          </button>
        )}
      </div>
    </aside>
  );
}
