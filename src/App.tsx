import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Library } from "@/pages/Library";
import { WorkspaceHost } from "@/pages/WorkspaceHost";
import { SettingsPage } from "@/pages/Settings";
import { SearchPage } from "@/pages/SearchPage";
import { AskPage } from "@/pages/AskPage";
import { TimelinePage } from "@/pages/TimelinePage";
import { HelpPage } from "@/pages/HelpPage";
import { NavRail, type NavItem } from "@/components/NavRail";
import { BrowserImportNotice, type BrowserImportPhase } from "@/components/BrowserImportNotice";
import { importBrowserDownload, importPdfUrl, parsePdf } from "@/lib/api";
import {
  closeTab,
  loadReaderTabs,
  openTab,
  saveReaderTabs,
  setTabTitle,
  type ReaderTabsState,
} from "@/lib/readerTabs";
import { displayPaperTitle } from "@/lib/utils";

type View =
  | { name: "workspace" }
  | { name: "timeline" }
  | { name: "search" }
  | { name: "ask" }
  | { name: "settings" }
  | { name: "help" };

function App() {
  const [view, setView] = useState<View>({ name: "workspace" });
  const [readerState, setReaderState] = useState<ReaderTabsState>(loadReaderTabs);
  const [libraryRefreshSignal, setLibraryRefreshSignal] = useState(0);
  const [browserImport, setBrowserImport] = useState<{
    phase: BrowserImportPhase;
    title: string;
    message: string;
  } | null>(null);
  const handledLinks = useRef(new Set<string>());
  const importQueue = useRef(Promise.resolve());

  useEffect(() => {
    const preventNativeMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventNativeMenu);
    return () => document.removeEventListener("contextmenu", preventNativeMenu);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const handleLinks = (links: string[]) => {
      for (const rawLink of links) {
        let link: URL;
        try {
          link = new URL(rawLink);
        } catch {
          continue;
        }
        if (link.protocol !== "zoompaper:" || link.hostname !== "import") continue;
        const pdfUrl = link.searchParams.get("pdf");
        const localFile = link.searchParams.get("file");
        if (!pdfUrl && !localFile) continue;
        const title = link.searchParams.get("title")?.trim() || "浏览器中的论文";
        const sourceUrl = link.searchParams.get("source");
        const githubUrl = link.searchParams.get("github");
        const venue = link.searchParams.get("venue");
        const sourceIconUrl = link.searchParams.get("icon");
        const requestId = link.searchParams.get("request") || rawLink;
        if (handledLinks.current.has(requestId)) continue;
        handledLinks.current.add(requestId);

        importQueue.current = importQueue.current.then(async () => {
          if (disposed) return;
          setView({ name: "workspace" });
          setReaderState((s) => ({ ...s, activeTabId: null }));
          setBrowserImport({ phase: "downloading", title, message: "正在安全下载 PDF…" });
          try {
            const paper = localFile
              ? await importBrowserDownload(localFile, title, sourceUrl, githubUrl, venue, sourceIconUrl)
              : await importPdfUrl(pdfUrl!, title, sourceUrl, githubUrl, venue, sourceIconUrl);
            if (disposed) return;
            setLibraryRefreshSignal((value) => value + 1);
            setBrowserImport({ phase: "parsing", title: paper.title, message: "已保存，正在提取正文与元数据…" });
            try {
              await parsePdf(paper.id);
              if (disposed) return;
              setLibraryRefreshSignal((value) => value + 1);
              setBrowserImport({ phase: "done", title: paper.title, message: "" });
            } catch (error) {
              if (disposed) return;
              setLibraryRefreshSignal((value) => value + 1);
              setBrowserImport({ phase: "warning", title: paper.title, message: `PDF 已保存；自动解析失败：${String(error)}` });
            }
          } catch (error) {
            if (disposed) return;
            setBrowserImport({ phase: "error", title, message: String(error) });
          }
        });
      }
    };

    void getCurrent().then((links) => links && handleLinks(links));
    void onOpenUrl(handleLinks).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const openPaper = (paperId: string, pageIdx?: number) => {
    setReaderState((s) => openTab(s, paperId, pageIdx));
    setView({ name: "workspace" });
  };
  const activateReaderTab = (tabId: string) =>
    setReaderState((s) => ({ ...s, activeTabId: tabId }));
  const activateHomeTab = () =>
    setReaderState((s) => ({ ...s, activeTabId: null }));
  const closeReaderTab = (tabId: string) =>
    setReaderState((s) => closeTab(s, tabId));

  // 标签条变更即持久化，重启应用后恢复
  useEffect(() => {
    saveReaderTabs(readerState);
  }, [readerState]);

  // 从论文标签回到主页标签时刷新论文库（阅读页可能改了在读/已读状态）
  const prevActiveTabRef = useRef<string | null>(readerState.activeTabId);
  useEffect(() => {
    const prev = prevActiveTabRef.current;
    prevActiveTabRef.current = readerState.activeTabId;
    if (prev !== null && readerState.activeTabId === null) {
      setLibraryRefreshSignal((v) => v + 1);
    }
  }, [readerState.activeTabId]);

  // 工作区（含主页标签与论文标签）归属「论文库」导航高亮
  const activeNav: NavItem = view.name === "workspace" ? "library" : view.name;

  const handleNavSelect = (name: NavItem) => {
    if (name === "library") {
      setView({ name: "workspace" });
      activateHomeTab();
    } else {
      setView({ name } as View);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 56px 图标导航（全局） */}
      <NavRail
        active={activeNav}
        onSelect={handleNavSelect}
      />

      {/* 主内容区：各页面自行控制滚动；workspace 为主页标签（论文库）+ 论文标签 */}
      <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${view.name === "ask" ? "bg-white dark:bg-[#191919]" : "p-6"}`}>
        <motion.div
          key={view.name}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {view.name === "workspace" && (
            <WorkspaceHost
              tabs={readerState.tabs}
              activeTabId={readerState.activeTabId}
              onActivate={activateReaderTab}
              onClose={closeReaderTab}
              onActivateHome={activateHomeTab}
              home={<Library onOpenPaper={openPaper} refreshSignal={libraryRefreshSignal} />}
              onPaperLoaded={(tabId, paper) =>
                setReaderState((s) => setTabTitle(s, tabId, displayPaperTitle(paper.title)))
              }
            />
          )}
          {view.name === "search" && <SearchPage onOpenPaper={openPaper} />}
          {view.name === "timeline" && <TimelinePage onOpenPaper={openPaper} />}
          {view.name === "ask" && <AskPage onOpenPaper={openPaper} />}
          {view.name === "settings" && <SettingsPage />}
          {view.name === "help" && <HelpPage />}
        </motion.div>
      </main>
      {browserImport && (
        <BrowserImportNotice {...browserImport} onClose={() => setBrowserImport(null)} />
      )}
    </div>
  );
}

export default App;
