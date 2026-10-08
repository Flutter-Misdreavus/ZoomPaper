import { useCallback, useEffect, useState } from "react";
import { QaChat } from "@/components/QaChat";
import { ConversationDeleteDialog } from "@/components/ConversationDeleteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { deleteConversation, listConversations, type Conversation } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import { History, Plus, Trash2 } from "lucide-react";

interface Props {
  onOpenPaper: (paperId: string, pageIdx?: number) => void;
}

/** 跨论文知识库问答：Codex 风格单栏工作区，会话历史收进右上角。 */
export function AskPage({ onOpenPaper }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatRevision, setChatRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
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

  function startNew() {
    if (sending) return;
    setActiveId(null);
    setChatRevision((v) => v + 1);
    setHistoryOpen(false);
  }

  function selectConversation(id: string) {
    if (sending) return;
    setActiveId(id);
    setChatRevision((v) => v + 1);
    setHistoryOpen(false);
  }

  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteConversation(confirmDelete.id);
      if (activeId === confirmDelete.id) startNew();
      setConfirmDelete(null);
      void refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[#191919]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-zp-border px-7">
        <h1 className="text-sm font-medium">知识库问答</h1>
        <div className="flex items-center gap-0.5">
          <IconTooltip label={sending ? "回复中，暂时无法新建对话" : "新对话"} side="bottom"><button type="button" onClick={startNew} disabled={sending} aria-label="新对话" className="pressable rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
            <Plus className="h-4 w-4" />
          </button></IconTooltip>
          <IconTooltip label={sending ? "回复中，暂时无法切换会话" : "历史会话"} side="bottom">
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            <PopoverTrigger disabled={sending} aria-label="历史会话" className="pressable rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
              <History className="h-4 w-4" />
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={4} className="w-64 p-1">
              {loading ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">加载会话…</p>
              ) : conversations.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">暂无历史会话</p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {conversations.map((conversation) => (
                    <div key={conversation.id} className="group relative">
                      <button type="button" onClick={() => selectConversation(conversation.id)} className={`block w-full rounded-md px-2 py-1.5 pr-7 text-left transition-colors ${activeId === conversation.id ? "bg-accent text-accent-foreground" : "text-foreground/85 hover:bg-accent/50"}`}>
                        <div className="truncate text-[13px] font-medium">{conversation.title || "未命名会话"}</div>
                        <div className="text-[11px] text-muted-foreground">{formatTime(conversation.updated_at)}</div>
                      </button>
                      <IconTooltip label="删除会话" side="left" className="absolute top-1/2 right-1 -translate-y-1/2"><button type="button" onClick={(event) => { event.stopPropagation(); setConfirmDelete(conversation); }} aria-label="删除会话" className="pressable rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button></IconTooltip>
                    </div>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
          </IconTooltip>
        </div>
      </header>

      {error && <div className="mx-auto mt-3 w-full max-w-5xl rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 px-6 pb-6">
        <QaChat key={chatRevision} onSendingChange={setSending} conversationId={activeId} onOpenPaper={onOpenPaper} onConversationCreated={(id) => { setActiveId(id); void refresh(); }} />
      </div>

      <ConversationDeleteDialog conversation={confirmDelete} deleting={deleting} onConfirm={() => void handleDeleteConfirm()} onCancel={() => setConfirmDelete(null)} />
    </section>
  );
}
