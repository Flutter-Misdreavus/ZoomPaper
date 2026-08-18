import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QaChat } from "@/components/QaChat";
import { ConversationDeleteDialog } from "@/components/ConversationDeleteDialog";
import { deleteConversation, listConversations, type Conversation } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import { MessageSquare, Plus, Trash2 } from "lucide-react";

interface Props {
  onOpenPaper: (paperId: string, pageIdx?: number) => void;
}

/** 跨论文知识库问答：左侧会话列表 + 右侧对话区（支持新建 / 选择 / 删除） */
export function AskPage({ onOpenPaper }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** null = 新会话 */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 待删除确认的会话 */
  const [confirmDelete, setConfirmDelete] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  /** 确认删除：删除会话；若删的是当前会话则回到新会话 */
  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteConversation(confirmDelete.id);
      if (activeId === confirmDelete.id) setActiveId(null);
      setConfirmDelete(null);
      void refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

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
              <div key={c.id} className="group relative">
                <button
                  onClick={() => setActiveId(c.id)}
                  className={`block w-full rounded-md px-3 py-2 pr-8 text-left transition-colors ${
                    activeId === c.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                  }`}
                >
                  <div className="truncate text-sm font-medium">{c.title || "未命名会话"}</div>
                  <div className="mt-0.5 text-xs opacity-70">{formatTime(c.updated_at)}</div>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(c);
                  }}
                  title="删除会话"
                  className="pressable absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent/80 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
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

      {/* 删除会话确认弹窗 */}
      <ConversationDeleteDialog
        conversation={confirmDelete}
        deleting={deleting}
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
