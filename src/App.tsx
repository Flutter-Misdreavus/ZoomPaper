import { useState } from "react";
import { motion } from "motion/react";
import {
  BookOpen,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { Library } from "@/pages/Library";
import { Reader } from "@/pages/Reader";
import { SettingsPage } from "@/pages/Settings";
import { SearchPage } from "@/pages/SearchPage";
import { AskPage } from "@/pages/AskPage";

type View =
  | { name: "library" }
  | { name: "search" }
  | { name: "ask" }
  | { name: "reader"; paperId: string }
  | { name: "settings" };

const NAV = [
  { name: "library", label: "论文库", icon: BookOpen },
  { name: "search", label: "搜索", icon: Search },
  { name: "ask", label: "问答", icon: MessageSquare },
  { name: "settings", label: "设置", icon: SettingsIcon },
] as const;

function App() {
  const [view, setView] = useState<View>({ name: "library" });

  const openPaper = (paperId: string) => setView({ name: "reader", paperId });
  // 阅读页归属「论文库」导航高亮
  const activeNav = view.name === "reader" ? "library" : view.name;

  return (
    <div className="flex h-screen">
      {/* 侧边栏 */}
      <aside className="flex w-52 flex-col border-r bg-sidebar p-3">
        <div className="mb-6 flex items-center gap-2 px-2 pt-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <span className="text-lg font-bold tracking-tight">ZoomPaper</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = activeNav === item.name;
            const Icon = item.icon;
            return (
              <button
                key={item.name}
                onClick={() => setView({ name: item.name } as View)}
                className={`pressable relative flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "text-accent-foreground"
                    : "text-muted-foreground hover:text-accent-foreground"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="nav-indicator"
                    className="absolute inset-0 rounded-md bg-accent"
                    transition={{ type: "spring", duration: 0.4, bounce: 0 }}
                  />
                )}
                <Icon className="relative z-10 h-4 w-4" />
                <span className="relative z-10">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* 主内容区：页面自行控制滚动（问答/阅读需要定高布局） */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col p-6">
        <motion.div
          key={view.name + ("paperId" in view ? view.paperId : "")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {view.name === "library" && <Library onOpenPaper={openPaper} />}
          {view.name === "search" && <SearchPage onOpenPaper={openPaper} />}
          {view.name === "ask" && <AskPage onOpenPaper={openPaper} />}
          {view.name === "reader" && (
            <Reader
              paperId={view.paperId}
              onBack={() => setView({ name: "library" })}
            />
          )}
          {view.name === "settings" && <SettingsPage />}
        </motion.div>
      </main>
    </div>
  );
}

export default App;
