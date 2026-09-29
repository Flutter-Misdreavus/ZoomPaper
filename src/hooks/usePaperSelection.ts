/**
 * 论文库已选论文集合；选择模式本身由 Library 管理。
 */
import { useCallback, useMemo, useState } from "react";

export function usePaperSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /** 单击卡片：已选则取消，未选则追加（toggle 语义） */
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 批量加入（拖拽开始时把未选中的卡片并入选择集） */
  const add = useCallback((id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  /** 明确设置单篇的选择状态，供按住复选框拖动时连续“涂抹”使用。 */
  const setSelectedState = useCallback((id: string, value: boolean) => {
    setSelected((prev) => {
      if (prev.has(id) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback((ids: Iterable<string>) => setSelected(new Set(ids)), []);
  const isSelected = useCallback((id: string) => selected.has(id), [selected]);
  const size = selected.size;

  return useMemo(
    () => ({ selected, toggle, add, setSelectedState, clear, selectAll, isSelected, size }),
    [selected, toggle, add, setSelectedState, clear, selectAll, isSelected, size]
  );
}
