import { useCallback, useRef, useSyncExternalStore } from "react";

/** 隐藏面板保留最后一帧，任务仍由应用级仓库执行；恢复时读取最新快照。 */
export function useActiveSnapshot<T>(active: boolean, subscribe: (listener: () => void) => () => void, getSnapshot: () => T, storeKey?: string): T {
  const source = useRef({ subscribe, getSnapshot });
  source.current = { subscribe, getSnapshot };
  const cached = useRef<T>(getSnapshot());
  const listen = useCallback((listener: () => void) => active ? source.current.subscribe(listener) : () => {}, [active, storeKey]);
  const read = useCallback(() => {
    if (active) cached.current = source.current.getSnapshot();
    return cached.current;
  }, [active, storeKey]);
  return useSyncExternalStore(listen, read, read);
}
