import { useEffect, useState, type ReactNode } from "react";
import { Reader } from "@/pages/Reader";
import { ReaderTabBar } from "@/components/ReaderTabBar";
import {
  KEEP_ALIVE_CHANGED_EVENT,
  getReaderKeepAlive,
  mountedTabIds,
  pruneLru,
  touchLru,
  type ReaderTab,
} from "@/lib/readerTabs";
import type { Paper } from "@/lib/api";

interface Props {
  tabs: ReaderTab[];
  /** null = 主页标签（论文库）激活 */
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onActivateHome: () => void;
  /** 主页标签内容（论文库），常驻挂载保活 */
  home: ReactNode;
  onPaperLoaded: (tabId: string, paper: Paper) => void;
}

/** 工作区容器：标签条 + 主页（论文库）与论文标签的 keep-alive 实例集合，LRU 控制论文标签保活数量 */
export function WorkspaceHost({ tabs, activeTabId, onActivate, onClose, onActivateHome, home, onPaperLoaded }: Props) {
  // lruOrder：按最近激活排序（末尾最新）；只有激活过的标签才会挂载（懒挂载）
  const [lruOrder, setLruOrder] = useState<string[]>(() => (activeTabId ? [activeTabId] : []));
  const [keepAlive, setKeepAlive] = useState(getReaderKeepAlive);

  useEffect(() => {
    const onChanged = () => setKeepAlive(getReaderKeepAlive());
    window.addEventListener(KEEP_ALIVE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(KEEP_ALIVE_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    setLruOrder((order) => {
      const pruned = pruneLru(order, tabs);
      return activeTabId ? touchLru(pruned, activeTabId) : pruned;
    });
  }, [activeTabId, tabs]);

  const mounted = new Set(mountedTabIds(lruOrder, keepAlive));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <ReaderTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={onActivate}
        onClose={onClose}
        onActivateHome={onActivateHome}
      />
      {/* 主页（论文库）常驻挂载：切到论文标签再回来时滚动/多选状态保留 */}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ display: activeTabId === null ? "flex" : "none" }}
      >
        {home}
      </div>
      {tabs
        .filter((tab) => mounted.has(tab.id))
        .map((tab) => (
          // 非激活标签 display:none 保活：滚动位置、问答会话、PDF 渲染结果全部保留
          <div
            key={tab.id}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={{ display: tab.id === activeTabId ? "flex" : "none" }}
          >
            <Reader
              paperId={tab.paperId}
              initialPageIdx={tab.pageIdx}
              jumpNonce={tab.jumpNonce}
              active={tab.id === activeTabId}
              onPaperLoaded={(paper) => onPaperLoaded(tab.id, paper)}
            />
          </div>
        ))}
    </div>
  );
}
