import { useState } from "react";
import { motion } from "motion/react";
import { Library } from "@/pages/Library";
import { Reader } from "@/pages/Reader";
import { SettingsPage } from "@/pages/Settings";
import { SearchPage } from "@/pages/SearchPage";
import { AskPage } from "@/pages/AskPage";
import { NavRail, type NavItem } from "@/components/NavRail";

type View =
  | { name: "library" }
  | { name: "search" }
  | { name: "ask" }
  | { name: "reader"; paperId: string; pageIdx?: number }
  | { name: "settings" };

function App() {
  const [view, setView] = useState<View>({ name: "library" });

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
        <Library onOpenPaper={openPaper} />
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
    </div>
  );
}

export default App;
