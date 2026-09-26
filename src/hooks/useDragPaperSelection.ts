import { useCallback, useEffect, useRef } from "react";

/**
 * 在多选模式中按住复选框拖过论文行/卡片，连续应用起点的目标状态。
 * 从未选项开始为批量选择；从已选项开始为批量取消。
 */
export function useDragPaperSelection(
  setSelected: (id: string, selected: boolean) => void,
) {
  const dragRef = useRef<{ active: boolean; selected: boolean } | null>(null);
  const suppressClickUntilRef = useRef(0);

  const stop = useCallback(() => {
    if (dragRef.current?.active) suppressClickUntilRef.current = Date.now() + 400;
    dragRef.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [stop]);

  const start = useCallback((id: string, currentlySelected: boolean) => {
    const selected = !currentlySelected;
    suppressClickUntilRef.current = Number.POSITIVE_INFINITY;
    dragRef.current = { active: true, selected };
    setSelected(id, selected);
  }, [setSelected]);

  const enter = useCallback((id: string) => {
    const drag = dragRef.current;
    if (drag?.active) setSelected(id, drag.selected);
  }, [setSelected]);

  const shouldSuppressClick = useCallback(
    () => dragRef.current?.active === true || Date.now() < suppressClickUntilRef.current,
    [],
  );

  return { start, enter, stop, shouldSuppressClick };
}
