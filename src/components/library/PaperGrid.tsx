/**
 * 卡片网格容器（PaperGrid）：自适应列 minmax(300px, 1fr)，gap 16px。
 */
import type { ReactNode } from "react";

export function PaperGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
      {children}
    </div>
  );
}
