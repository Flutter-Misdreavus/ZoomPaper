import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Library } from "@/pages/Library";
import { Reader } from "@/pages/Reader";
import { SettingsPage } from "@/pages/Settings";
import { SearchPage } from "@/pages/SearchPage";
import { AskPage } from "@/pages/AskPage";
import { TimelinePage } from "@/pages/TimelinePage";
import { NavRail, type NavItem } from "@/components/NavRail";
import { BrowserImportNotice, type BrowserImportPhase } from "@/components/BrowserImportNotice";
import { importBrowserDownload, importPdfUrl, parsePdf } from "@/lib/api";

type View =
  | { name: "library" }
  | { name: "timeline" }
  | { name: "search" }
  | { name: "ask" }
  | { name: "reader"; paperId: string; pageIdx?: number }
  | { name: "settings" };

function App() {
  const [view, setView] = useState<View>({ name: "library" });
  const [libraryRefreshSignal, setLibraryRefreshSignal] = useState(0);
  const [browserImport, setBrowserImport] = useState<{
    phase: BrowserImportPhase;
    title: string;
    message: string;
  } | null>(null);
  const handledLinks = useRef(new Set<string>());
  const importQueue = useRef(Promise.resolve());

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
        const requestId = link.searchParams.get("request") || rawLink;
        if (handledLinks.current.has(requestId)) continue;
        handledLinks.current.add(requestId);

        importQueue.current = importQueue.current.then(async () => {
          if (disposed) return;
          setView({ name: "library" });
          setBrowserImport({ phase: "downloading", title, message: "正在安全下载 PDF…" });
          try {
            const paper = localFile
              ? await importBrowserDownload(localFile, title)
              : await importPdfUrl(pdfUrl!, title);
            if (disposed) return;
            setLibraryRefreshSignal((value) => value + 1);
            setBrowserImport({ phase: "parsing", title: paper.title, message: "已保存，正在提取正文与元数据…" });
            try {
              await parsePdf(paper.id);
              if (disposed) return;
              setLibraryRefreshSignal((value) => value + 1);
              setBrowserImport({ phase: "done", title: paper.title, message: "现在可以开始阅读、翻译和提问。" });
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

  const openPaper = (paperId: string, pageIdx?: number) =>
    setView({ name: "reader", paperId, pageIdx });
  // 阅读页归属「论文库」导航高亮
  const activeNav: NavItem = view.name === "reader" ? "library" : view.name;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 56px 图标导航（全局） */}
      <NavRail
        active={activeNav}
        onSelect={(name) => setView({ name } as View)}
      />

      {view.name === "library" ? (
        /* 论文库工作台：文件夹侧栏 + 内容区由 Library 自行组织 */
        <Library onOpenPaper={openPaper} refreshSignal={libraryRefreshSignal} />
      ) : (
        /* 其余页面：主内容区自行控制滚动 */
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-6">
          <motion.div
            key={view.name + ("paperId" in view ? view.paperId : "")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {view.name === "search" && <SearchPage onOpenPaper={openPaper} />}
            {view.name === "timeline" && <TimelinePage onOpenPaper={openPaper} />}
            {view.name === "ask" && <AskPage onOpenPaper={openPaper} />}
            {view.name === "reader" && (
              <Reader
                paperId={view.paperId}
                initialPageIdx={view.pageIdx}
                onBack={() => setView({ name: "library" })}
              />
            )}
            {view.name === "settings" && <SettingsPage />}
          </motion.div>
        </main>
      )}
      {browserImport && (
        <BrowserImportNotice {...browserImport} onClose={() => setBrowserImport(null)} />
      )}
    </div>
  );
}

export default App;
