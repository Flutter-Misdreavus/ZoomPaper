import { useEffect, useState } from "react";

/** 整秒格式（DSH 风格）：<60s → "12s"；≥60s → "2m05s" */
export function fmtDur(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * 实时计时：挂载即从 0 开始、**每秒**跳动（DSH `TurnStatus` 同款）。
 * 仅挂载在生成/思考阶段，完成后组件卸载即消失。
 */
export function LiveClock() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setSecs(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{fmtDur(secs)}</span>;
}
