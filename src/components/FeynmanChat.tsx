import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/MarkdownView";
import {
  feynmanReview,
  feynmanStart,
  feynmanTurn,
  getFeynmanConversation,
  type FeynmanMessage,
} from "@/lib/api";
import {
  GraduationCap,
  Loader2,
  Play,
  RotateCcw,
  SendHorizonal,
  Sparkles,
} from "lucide-react";

interface Props {
  paperId: string;
}

/**
 * 费曼学习法对话：用户扮演老师讲解论文概念，AI 扮演「聪明但陌生的本科生」
 * 追问 / 要类比 / 偶尔故意犯错。支持会话记忆（自动恢复最近会话）与一键复盘。
 */
export function FeynmanChat({ paperId }: Props) {
  const [messages, setMessages] = useState<FeynmanMessage[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 恢复该论文最近的费曼会话
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    getFeynmanConversation(paperId)
      .then((conv) => {
        if (cancelled || !conv) return;
        setConvId(conv.id);
        try {
          setMessages(JSON.parse(conv.messages) as FeynmanMessage[]);
        } catch {
          setError("会话历史解析失败");
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  // 新消息 / 复盘滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending, review, starting]);

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const turn = await feynmanStart(paperId);
      setConvId(turn.conversation_id);
      setMessages([{ role: "assistant", content: turn.reply }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    setReview(null);
    setMessages((prev) => [...prev, { role: "user", content }]);
    try {
      const turn = await feynmanTurn(content, paperId, convId);
      setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      if (!convId) setConvId(turn.conversation_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  async function handleReview() {
    if (!convId || reviewing) return;
    setReviewing(true);
    setReview(null);
    setError(null);
    try {
      setReview(await feynmanReview(convId));
    } catch (e) {
      setError(String(e));
    } finally {
      setReviewing(false);
    }
  }

  function handleRestart() {
    setConvId(null);
    setMessages([]);
    setReview(null);
    setError(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {messages.length > 0 && (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRestart}
            disabled={sending || reviewing}
            title="重新开始"
            className="pressable h-7 gap-1 px-2 text-xs text-muted-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重新开始
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleReview()}
            disabled={!convId || reviewing || sending}
            title="生成教学复盘"
            className="pressable h-7 gap-1 px-2 text-xs"
          >
            {reviewing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            复盘
          </Button>
        </div>
      )}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2">
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载会话…
          </div>
        ) : starting ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">正在生成开场白…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center text-muted-foreground">
            <GraduationCap className="h-10 w-10" />
            <p className="max-w-md text-sm">
              你已经读完论文，扮演老师向学生讲解论文概念。可直接输入开始讲解，或让 AI 先开场。
            </p>
            <Button onClick={() => void handleStart()} disabled={starting} className="pressable gap-2">
              <Play className="h-4 w-4" />
              AI 开场白
            </Button>
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
                  <MarkdownView markdown={m.content} className="prose-sm" />
                </div>
              </div>
            ),
          )
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              思考中…
            </div>
          </div>
        )}

        {review && (
          <div className="flex justify-start">
            <div className="max-w-[95%] rounded-2xl border border-primary/20 bg-accent/40 px-4 py-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                教学复盘
              </div>
              <MarkdownView markdown={review} className="prose-sm" />
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
          placeholder="讲解你理解的论文概念…（Enter 发送，Shift+Enter 换行）"
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
