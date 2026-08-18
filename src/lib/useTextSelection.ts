import { useEffect, useRef } from "react";
import { computeOffsets } from "@/lib/textAnnotate";

/** 一次划选结果（已映射为容器内偏移 + 屏幕坐标） */
export interface PendingSelection {
  x: number;
  y: number;
  text: string;
  start: number;
  end: number;
}

/**
 * 文本划选监听：document mouseup 时检测非空选区，定位其所属的已注册内容容器
 * （`containersRef` 的元素 → docKey 映射），计算容器内字符偏移并回调。
 *
 * 一个页面可注册多个容器（如博客的剖析区 + 正文、译文的逐段容器）；
 * 容器元素用 callback ref 写入 `containersRef`，本 hook 每次事件实时读取（无需重绑）。
 */
export function useTextSelection(
  containersRef: React.RefObject<Map<HTMLElement, string>>,
  onSelection: (docKey: string, sel: PendingSelection) => void,
) {
  const cbRef = useRef(onSelection);
  cbRef.current = onSelection;

  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const selObj = window.getSelection();
      if (!selObj || selObj.isCollapsed || selObj.rangeCount === 0) return;
      const range = selObj.getRangeAt(0);
      const startNode: Node =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement ?? range.startContainer
          : range.startContainer;

      let found: { el: HTMLElement; docKey: string } | null = null;
      for (const [el, docKey] of containersRef.current) {
        if (el.contains(startNode)) {
          found = { el, docKey };
          break;
        }
      }
      if (!found) return;

      const offsets = computeOffsets(found.el, range);
      if (!offsets) return;
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      cbRef.current(found.docKey, {
        x: Math.min(last.left, window.innerWidth - 320),
        y: last.bottom + 8,
        text: offsets.text,
        start: offsets.start,
        end: offsets.end,
      });
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
