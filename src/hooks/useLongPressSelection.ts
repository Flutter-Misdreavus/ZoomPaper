import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const HOLD_MS = 500;
const MOVE_LIMIT = 9;

/** 论文行/卡片长按进入多选；触发后指针可继续划过其他论文完成连续选择。 */
export function useLongPressSelection(onLongPress: (id: string) => void) {
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;
  const pressRef = useRef<{ id: string; x: number; y: number; timer: number } | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const recentHoldRef = useRef<{ id: string; until: number } | null>(null);

  function cancel() {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }

  useEffect(() => () => cancel(), []);

  function bind(id: string) {
    return {
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        if (event.button !== 0 || !event.isPrimary) return;
        if ((event.target as HTMLElement).closest("button, a, input, textarea, select, [role='menuitem'], [contenteditable='true']")) return;
        cancel();
        const { clientX: x, clientY: y } = event;
        const timer = window.setTimeout(() => {
          pressRef.current = null;
          suppressClickRef.current = id;
          recentHoldRef.current = { id, until: Date.now() + 800 };
          callbackRef.current(id);
          window.setTimeout(() => {
            if (suppressClickRef.current === id) suppressClickRef.current = null;
          }, 700);
        }, HOLD_MS);
        pressRef.current = { id, x, y, timer };
      },
      onPointerMove(event: ReactPointerEvent<HTMLElement>) {
        const press = pressRef.current;
        if (press?.id === id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_LIMIT) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    };
  }

  function consumeClick(id: string): boolean {
    if (suppressClickRef.current !== id) return false;
    suppressClickRef.current = null;
    return true;
  }

  function suppressContextMenu(id: string): boolean {
    return recentHoldRef.current?.id === id && Date.now() < recentHoldRef.current.until;
  }

  return { bind, cancel, consumeClick, suppressContextMenu };
}
