import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderTabBar } from "@/components/ReaderTabBar";
import {
  closeTab,
  getReaderKeepAlive,
  loadReaderTabs,
  mountedTabIds,
  openTab,
  pruneLru,
  saveReaderTabs,
  setReaderKeepAlive,
  setTabTitle,
  touchLru,
  type ReaderTab,
  type ReaderTabsState,
} from "@/lib/readerTabs";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function stateWith(...paperIds: string[]): ReaderTabsState {
  let state: ReaderTabsState = { tabs: [], activeTabId: null };
  for (const id of paperIds) state = openTab(state, id);
  return state;
}

it("openTab 新建标签并激活", () => {
  const state = openTab({ tabs: [], activeTabId: null }, "p1");
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs[0].paperId).toBe("p1");
  expect(state.activeTabId).toBe(state.tabs[0].id);
});

it("openTab 复用同论文标签，不新建", () => {
  let state = stateWith("p1", "p2");
  state = openTab(state, "p1");
  expect(state.tabs).toHaveLength(2);
  expect(state.activeTabId).toBe(state.tabs[0].id);
});

it("openTab 复用带页码时递增 jumpNonce", () => {
  let state = stateWith("p1", "p2");
  state = openTab(state, "p1", 5);
  const tab = state.tabs.find((t) => t.paperId === "p1")!;
  expect(tab.jumpNonce).toBe(1);
  expect(tab.pageIdx).toBe(5);
});

it("closeTab 关闭激活标签时优先激活右侧邻居", () => {
  let state = stateWith("p1", "p2", "p3");
  // 激活 p2（中间的）
  state = { ...state, activeTabId: state.tabs[1].id };
  state = closeTab(state, state.tabs[1].id);
  expect(state.tabs.map((t) => t.paperId)).toEqual(["p1", "p3"]);
  expect(state.activeTabId).toBe(state.tabs[1].id); // p3
});

it("closeTab 关闭末尾激活标签时激活左侧邻居", () => {
  let state = stateWith("p1", "p2");
  state = closeTab(state, state.tabs[1].id);
  expect(state.activeTabId).toBe(state.tabs[0].id);
});

it("closeTab 关闭非激活标签不影响激活态", () => {
  let state = stateWith("p1", "p2");
  const active = state.activeTabId;
  state = closeTab(state, state.tabs[0].id);
  expect(state.activeTabId).toBe(active);
});

it("closeTab 关闭最后一个标签后 activeTabId 为 null", () => {
  const state = stateWith("p1");
  const closed = closeTab(state, state.tabs[0].id);
  expect(closed.tabs).toHaveLength(0);
  expect(closed.activeTabId).toBeNull();
});

it("setTabTitle 回填标签标题", () => {
  let state = stateWith("p1");
  state = setTabTitle(state, state.tabs[0].id, "论文标题");
  expect(state.tabs[0].title).toBe("论文标题");
});

it("LRU：touchLru 移到末尾，mountedTabIds 取末尾 N 个", () => {
  const state = stateWith("p1", "p2", "p3");
  const [a, b, c] = state.tabs.map((t) => t.id);
  const order = touchLru(touchLru(touchLru([], a), b), c);
  expect(mountedTabIds(order, 2)).toEqual([b, c]);
  expect(mountedTabIds(touchLru(order, a), 2)).toEqual([c, a]);
});

it("pruneLru 清理已关闭的标签", () => {
  const state = stateWith("p1", "p2");
  const order = ["gone", state.tabs[0].id, state.tabs[1].id];
  expect(pruneLru(order, state.tabs)).toEqual([state.tabs[0].id, state.tabs[1].id]);
});

it("keepAlive 读写 localStorage 并收敛到合法范围", () => {
  expect(getReaderKeepAlive()).toBe(3);
  setReaderKeepAlive(5);
  expect(getReaderKeepAlive()).toBe(5);
  setReaderKeepAlive(99);
  expect(getReaderKeepAlive()).toBe(10);
  setReaderKeepAlive(0);
  expect(getReaderKeepAlive()).toBe(1);
});

it("标签状态 localStorage 持久化 round-trip，损坏数据回退空状态", () => {
  const state = stateWith("p1", "p2");
  saveReaderTabs(state);
  const loaded = loadReaderTabs();
  expect(loaded.tabs.map((t) => t.paperId)).toEqual(["p1", "p2"]);
  expect(loaded.activeTabId).toBe(state.activeTabId);
  localStorage.setItem("zoompaper.readerTabs", "{bad json");
  expect(loadReaderTabs()).toEqual({ tabs: [], activeTabId: null });
});

it("loadReaderTabs 原样恢复主页激活态（activeTabId: null）", () => {
  const state = stateWith("p1");
  saveReaderTabs({ tabs: state.tabs, activeTabId: null });
  const loaded = loadReaderTabs();
  expect(loaded.tabs).toHaveLength(1);
  expect(loaded.activeTabId).toBeNull();
});

it("TabBar 主页标签固定最左、不可关闭，点击触发 onActivateHome", () => {
  const onActivateHome = vi.fn();
  render(
    <ReaderTabBar
      tabs={[{ id: "a", paperId: "p1", title: "第一篇", jumpNonce: 0 }]}
      activeTabId="a"
      onActivate={() => {}}
      onClose={() => {}}
      onActivateHome={onActivateHome}
    />,
  );
  const homeTab = screen.getByRole("tab", { name: "主页" });
  expect(homeTab.getAttribute("aria-selected")).toBe("false");
  expect(screen.queryByRole("button", { name: "关闭 主页" })).toBeNull();
  fireEvent.click(homeTab);
  expect(onActivateHome).toHaveBeenCalledTimes(1);
});

it("TabBar 点击切换与中键/按钮关闭", () => {
  const tabs: ReaderTab[] = [
    { id: "a", paperId: "p1", title: "第一篇", jumpNonce: 0 },
    { id: "b", paperId: "p2", title: "第二篇", jumpNonce: 0 },
  ];
  const onActivate = vi.fn();
  const onClose = vi.fn();
  render(
    <ReaderTabBar
      tabs={tabs}
      activeTabId="a"
      onActivate={onActivate}
      onClose={onClose}
      onActivateHome={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /第二篇/ }));
  expect(onActivate).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getByRole("button", { name: "关闭 第一篇" }));
  expect(onClose).toHaveBeenCalledWith("a");
  // 关闭按钮不应触发标签切换
  expect(onActivate).toHaveBeenCalledTimes(1);
});
