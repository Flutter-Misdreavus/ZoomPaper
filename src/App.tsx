import { useState } from "react";
import { BookOpen, Settings as SettingsIcon } from "lucide-react";
import { Library } from "@/pages/Library";
import { Reader } from "@/pages/Reader";
import { SettingsPage } from "@/pages/Settings";

type View = { name: "library" } | { name: "reader"; paperId: string } | { name: "settings" };

function App() {
  const [view, setView] = useState<View>({ name: "library" });

  return (
    <div className="flex h-screen">
      {/* 侧边栏 */}
      <aside className="flex w-52 flex-col border-r bg-sidebar p-3">
        <div className="mb-6 flex items-center gap-2 px-2 pt-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <span className="text-lg font-bold tracking-tight">ZoomPaper</span>
        </div>
        <nav className="flex flex-col gap-1">
          <button
            onClick={() => setView({ name: "library" })}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              view.name === "library"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
            }`}
          >
            <BookOpen className="h-4 w-4" />
            论文库
          </button>
          <button
            onClick={() => setView({ name: "settings" })}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              view.name === "settings"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
            }`}
          >
            <SettingsIcon className="h-4 w-4" />
            设置
          </button>
        </nav>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 overflow-y-auto p-6">
        {view.name === "library" && (
          <Library onOpenPaper={(id) => setView({ name: "reader", paperId: id })} />
        )}
        {view.name === "reader" && (
          <Reader
            paperId={view.paperId}
            onBack={() => setView({ name: "library" })}
          />
        )}
        {view.name === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

export default App;
