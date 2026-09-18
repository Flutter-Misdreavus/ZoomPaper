import { useEffect, useRef, useState } from "react";

/** 距底多少 px 以内视为「贴底」（吸附跟随滚动） */
const BOTTOM_THRESHOLD = 80;

/**
 * 吸底滚动（ChatGPT/Claude 同款）：只有用户位于底部附近时，内容变化才跟随滚到底；
 * 用户上翻超过阈值立即停止跟随（由调用方浮出「回到底部」按钮），滚回阈值内自动恢复吸附。
 *
 * - 内容增长（流式 token、图片加载）不触发 scroll 事件，吸附标记保持 true，跟随不中断；
 * - 自己发消息时调 `stick()`（配合紧随其后的内容变更，由 effect 完成滚动）；
 * - 点「回到底部」调 `scrollToBottom()`（立即滚动并恢复吸附）。
 */
export function useStickyScroll(deps: unknown[]) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // 同步镜像，供滚动 effect 做即时判断（避免闭包读到旧 state）
  const atBottomRef = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    atBottomRef.current = at;
    setAtBottom(at);
  }

  /** 立即滚到底并恢复吸附 */
  function scrollToBottom() {
    const el = scrollRef.current;
    atBottomRef.current = true;
    setAtBottom(true);
    el?.scrollTo({ top: el.scrollHeight });
  }

  /** 恢复吸附标记（不立即滚动；紧随的内容变更由下方 effect 滚到底） */
  function stick() {
    atBottomRef.current = true;
    setAtBottom(true);
  }

  // 内容变化时：仅当用户贴底才跟随滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { scrollRef, atBottom, onScroll, scrollToBottom, stick };
}
