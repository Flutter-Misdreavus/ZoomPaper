import { useCallback, useEffect, useRef } from "react";

/** Paint one selection state across cards while their checkbox is held. */
export function useDragPaperSelection(
  setSelected: (id: string, selected: boolean) => void,
) {
  const dragRef = useRef<{ selected: boolean } | null>(null);

  const stop = useCallback(() => {
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
    dragRef.current = { selected };
    setSelected(id, selected);
  }, [setSelected]);

  const enter = useCallback((id: string) => {
    const drag = dragRef.current;
    if (drag) setSelected(id, drag.selected);
  }, [setSelected]);

  return { start, enter };
}
