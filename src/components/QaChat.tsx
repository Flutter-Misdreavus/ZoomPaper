import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CitationBadge } from "@/components/CitationBadge";
import { resolveImgSrc } from "@/components/MarkdownView";
import {
  askQuestion,
  getConversation,
  type Citation,
  type QaMessage,
} from "@/lib/api";
import { Loader2, MessageSquare, SendHorizonal } from "lucide-react";

interface Props {
  /** null/缺省 = 跨论文问答 */
  paperId?: string | null;
  /** 已有会话 id；null/缺省 = 新会话 */
  conversationId?: string | null;
  onOpenPaper?: (paperId: string, pageIdx?: number) => void;
  /** 单篇阅读场景：引用在 PDF 内跳页（0-based） */
  onJumpPage?: (pageIdx: number) => void;
  /** 新会话第一次提问成功后回调（AskPage 刷新会话列表） */
  onConversationCreated?: (conversationId: string) => void;
}

// 把正文里的 [n] 改写成 markdown 链接，交给自定义 a 渲染成 CitationBadge
function linkifyCitations(md: string): string {
  return md.replace(/\[(\d+)\]/g, "[$1](citation:$1)");
}

interface AssistantBodyProps {
  content: string;
  citations: Citation[] | null | undefined;
  onOpenPaper?: (paperId: string, pageIdx?: number) => void;
  onJumpPage?: (pageIdx: number) => void;
}

function AssistantBody({ content, citations, onOpenPaper, onJumpPage }: AssistantBodyProps) {
  return (
    <article className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // citation: 是内部引用标记协议，放行；其余走默认消毒
        urlTransform={(url) =>
          url.startsWith("citation:") ? url : defaultUrlTransform(url)
        }
        components={{
          img: ({ src, alt }) => <img src={resolveImgSrc(src)} alt={alt} />,
          a: ({ href, children }) => {
            if (href?.startsWith("citation:")) {
              const index = Number(href.slice("citation:".length));
              return (
                <CitationBadge
                  index={index}
                  citation={citations?.find((c) => c.index === index)}
                  onOpenPaper={onOpenPaper}
                  onJumpPage={onJumpPage}
                />
              );
            }
            return <a href={href}>{children}</a>;
          },
        }}
      >
        {linkifyCitations(content)}
      </ReactMarkdown>
    </article>
  );
}

export function QaChat({ paperId, conversationId, onOpenPaper, onJumpPage, onConversationCreated }: Props) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 载入历史会话
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setLoadingHistory(true);
    getConversation(conversationId)
      .then((conv) => {
        if (cancelled) return;
        try {
          setMessages(JSON.parse(conv.messages) as QaMessage[]);
        } catch {
          setError("会话历史解析失败");
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // 新消息滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  async function handleSend() {
    const question = input.trim();
    if (!question || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    try {
      const ans = await askQuestion(question, { paperId: paperId ?? null, conversationId: convId });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: ans.answer, citations: ans.citations },
      ]);
      if (!convId) {
        setConvId(ans.conversation_id);
        onConversationCreated?.(ans.conversation_id);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2">
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载会话…
          </div>
        ) : messages.length === 0 && !sending ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <MessageSquare className="h-10 w-10" />
            <p className="text-sm">
              {paperId ? "就这篇论文提问，回答会附原文引用" : "跨论文提问，回答会附原文引用"}
            </p>
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
                  <AssistantBody
                    content={m.content}
                    citations={m.citations}
                    onOpenPaper={onOpenPaper}
                    onJumpPage={onJumpPage}
                  />
                </div>
              </div>
            ),
          )
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              检索并生成回答…
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={paperId ? "针对这篇论文提问…（Enter 发送，Shift+Enter 换行）" : "向整个论文库提问…（Enter 发送，Shift+Enter 换行）"}
          className="min-h-11 flex-1 resize-none"
          rows={1}
        />
        <Button
          size="icon"
          onClick={() => void handleSend()}
          disabled={sending || !input.trim()}
          className="pressable h-11 w-11"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizonal className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
