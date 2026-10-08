// 阅读器多标签页：标签数据模型、去重/关闭/LRU 纯函数与 localStorage 持久化

export interface ReaderTab {
  id: string;
  paperId: string;
  /** 标签显示名，Reader 加载完成后由 onPaperLoaded 回填 */
  title: string;
  /** 待跳转页（0-based），如搜索结果/引用定位 */
  pageIdx?: number;
  /** 复用已有标签并带页码跳转时 +1，触发 Reader 内跳转 */
  jumpNonce: number;
}

export interface ReaderTabsState {
  tabs: ReaderTab[];
  /** null 表示没有打开的标签 */
  activeTabId: string | null;
}

const TABS_KEY = "zoompaper.readerTabs";
const KEEP_ALIVE_KEY = "zoompaper.readerKeepAlive";
export const KEEP_ALIVE_CHANGED_EVENT = "zoompaper:reader-keepalive-changed";

export const DEFAULT_KEEP_ALIVE = 3;
export const MIN_KEEP_ALIVE = 1;
export const MAX_KEEP_ALIVE = 10;

function newTabId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 打开论文：已有该论文的标签则复用激活（带页码时 bump jumpNonce），否则新建标签 */
export function openTab(
  state: ReaderTabsState,
  paperId: string,
  pageIdx?: number,
): ReaderTabsState {
  const existing = state.tabs.find((t) => t.paperId === paperId);
  if (existing) {
    const tabs = state.tabs.map((t) =>
      t.id === existing.id && pageIdx != null
        ? { ...t, pageIdx, jumpNonce: t.jumpNonce + 1 }
        : t,
    );
    return { tabs, activeTabId: existing.id };
  }
  const tab: ReaderTab = {
    id: newTabId(),
    paperId,
    title: "加载中…",
    pageIdx,
    jumpNonce: 0,
  };
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

/** 关闭标签：关闭激活标签时激活相邻标签（优先右侧）；无剩余标签时 activeTabId 为 null */
export function closeTab(state: ReaderTabsState, tabId: string): ReaderTabsState {
  const index = state.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== tabId);
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  if (tabs.length === 0) return { tabs, activeTabId: null };
  const next = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, activeTabId: next.id };
}

/** 回填标签标题（Reader 加载完成后调用） */
export function setTabTitle(
  state: ReaderTabsState,
  tabId: string,
  title: string,
): ReaderTabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
  };
}

/** 将标签标记为最近使用（移到末尾） */
export function touchLru(lruOrder: string[], tabId: string): string[] {
  return [...lruOrder.filter((id) => id !== tabId), tabId];
}

/** 计算应保活挂载的标签集合：lruOrder 末尾的 keepAlive 个 */
export function mountedTabIds(lruOrder: string[], keepAlive: number): string[] {
  return lruOrder.slice(-Math.max(keepAlive, MIN_KEEP_ALIVE));
}

/** 清理 lruOrder 中已关闭的标签 */
export function pruneLru(lruOrder: string[], tabs: ReaderTab[]): string[] {
  const alive = new Set(tabs.map((t) => t.id));
  return lruOrder.filter((id) => alive.has(id));
}

export function getReaderKeepAlive(): number {
  try {
    const raw = localStorage.getItem(KEEP_ALIVE_KEY);
    const n = raw == null ? NaN : Number.parseInt(raw, 10);
    if (Number.isFinite(n)) {
      return Math.min(Math.max(n, MIN_KEEP_ALIVE), MAX_KEEP_ALIVE);
    }
  } catch {
    // localStorage 不可用时用默认值
  }
  return DEFAULT_KEEP_ALIVE;
}

export function setReaderKeepAlive(n: number): void {
  const clamped = Math.min(Math.max(Math.round(n), MIN_KEEP_ALIVE), MAX_KEEP_ALIVE);
  try {
    localStorage.setItem(KEEP_ALIVE_KEY, String(clamped));
    window.dispatchEvent(new Event(KEEP_ALIVE_CHANGED_EVENT));
  } catch {
    // 忽略持久化失败
  }
}

export function loadReaderTabs(): ReaderTabsState {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ReaderTabsState;
      if (Array.isArray(parsed.tabs)) {
        const tabs = parsed.tabs.filter(
          (t) => t && typeof t.id === "string" && typeof t.paperId === "string",
        );
        const activeTabId =
          parsed.activeTabId && tabs.some((t) => t.id === parsed.activeTabId)
            ? parsed.activeTabId
            : (tabs[0]?.id ?? null);
        return { tabs, activeTabId };
      }
    }
  } catch {
    // 数据损坏时回退空状态
  }
  return { tabs: [], activeTabId: null };
}

export function saveReaderTabs(state: ReaderTabsState): void {
  try {
    if (state.tabs.length === 0) localStorage.removeItem(TABS_KEY);
    else localStorage.setItem(TABS_KEY, JSON.stringify(state));
  } catch {
    // 忽略持久化失败
  }
}
