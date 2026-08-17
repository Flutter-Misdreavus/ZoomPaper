import type { Timing } from "@/lib/api";

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** AI 耗时展示：⏱ AI 思考 X · 工具调用 Y（零值隐藏） */
export function TimingLine({ timing }: { timing?: Timing | null }) {
  if (!timing || (timing.model_ms === 0 && timing.tool_ms === 0)) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
      <span>⏱</span>
      <span>AI 思考 {fmtMs(timing.model_ms)}</span>
      {timing.tool_ms > 0 && <span>· 工具调用 {fmtMs(timing.tool_ms)}</span>}
    </div>
  );
}
