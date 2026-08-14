import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QaChat } from "@/components/QaChat";
import { listConversations, type Conversation } from "@/lib/api";
import { MessageSquare, Plus } from "lucide-react";

interface Props {
  onOpenPaper: (paperId: string, pageIdx?: number) => void;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 跨论文知识库问答：左侧会话列表 + 右侧对话区 */
export function AskPage({ onOpenPaper }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** null = 新会话 */
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // 只展示跨论文会话（paper_id 为 null）
      const all = await listConversations();
      setConversations(all.filter((c) => c.paper_id === null));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* 会话列表 */}
      <aside className="flex w-56 shrink-0 flex-col gap-2">
        <Button variant="outline" size="sm" onClick={() => setActiveId(null)}>
          <Plus className="mr-1 h-4 w-4" />
          新会话
        </Button>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {loading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : conversations.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">暂无历史会话</p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`pressable rounded-md px-3 py-2 text-left transition-colors ${
                  activeId === c.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <div className="truncate text-sm font-medium">{c.title || "未命名会话"}</div>
                <div className="mt-0.5 text-xs opacity-70">{formatTime(c.updated_at)}</div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* 对话区 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">知识库问答</h1>
        </div>
        {error && (
          <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <QaChat
          key={activeId ?? "new"}
          conversationId={activeId}
          onOpenPaper={onOpenPaper}
          onConversationCreated={(id) => {
            setActiveId(id);
            void refresh();
          }}
        />
      </section>
    </div>
  );
}
