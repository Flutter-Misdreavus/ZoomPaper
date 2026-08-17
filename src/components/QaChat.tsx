import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CitationBadge } from "@/components/CitationBadge";
import { LiveClock } from "@/components/LiveClock";
import { ThinkingPanel } from "@/components/ThinkingPanel";
import { TimingLine } from "@/components/TimingLine";
import { ToolTrace, type LiveToolStep } from "@/components/ToolTrace";
import {
  katexOptions,
  markdownUrlTransform,
  normalizeImageUrls,
  normalizeLatex,
  resolveImgSrc,
} from "@/lib/markdown";
import { WebToggle } from "@/components/WebToggle";
import {
  askQuestion,
  askQuestionReply,
  getConversation,
  getSettings,
  isWebSearchConfigured,
  type AgentEvent,
  type AnnotationRect,
  type Citation,
  type PendingAsk,
  type QaMessage,
} from "@/lib/api";
import { FileSearch, Loader2, MessageSquare, SendHorizonal, X } from "lucide-react";

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
  /** 阅读页选中的段落列表（上下文引用区，可多条；发送成功后自动清空） */
  selections?: { text: string; pageIdx: number; rects?: AnnotationRect[] }[] | null;
  onClearSelections?: () => void;
  /** 移除第 i 条引用 */
  onRemoveSelection?: (index: number) => void;
  /** 引用条数上限（达到时在头部提示） */
  maxSelections?: number;
  /** 引用悬停层「跳转到原文」：跳回 PDF 选中段落所在位置 */
  onJumpToSelection?: (pageIdx: number, rects?: AnnotationRect[]) => void;
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeKatex, katexOptions]]}
        // citation:/asset: 是内部协议，放行；其余走默认消毒
        urlTransform={markdownUrlTransform}
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
        {normalizeLatex(normalizeImageUrls(linkifyCitations(content)))}
      </ReactMarkdown>
    </article>
  );
}

export function QaChat({ paperId, conversationId, onOpenPaper, onJumpPage, onConversationCreated, selections, onClearSelections, onRemoveSelection, maxSelections, onJumpToSelection }: Props) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 问答模式：quick = 单轮 RAG；agent = 深度研究（多步工具循环，默认） */
  const [mode, setMode] = useState<"quick" | "agent">("agent");
  /** 联网搜索开关（默认开；未配置 provider 时显示「未配置」提示） */
  const [webOn, setWebOn] = useState(true);
  const [webConfigured, setWebConfigured] = useState(true);

  // 挂载时读取联网搜索配置状态
  useEffect(() => {
    getSettings()
      .then((s) => setWebConfigured(isWebSearchConfigured(s)))
      .catch(() => {});
  }, []);
  /** AI 澄清请求（ask_user）：非空时输入框改为作答澄清问题 */
  const [pending, setPending] = useState<PendingAsk | null>(null);
  /** 实时流式状态：思考文本 / 回答正文增量 / 工具轨迹（含 running 态） */
  const [thinkingText, setThinkingText] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [liveTrace, setLiveTrace] = useState<LiveToolStep[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 引用条目悬停：完整内容 + 「跳转到原文」（显示在条目左侧）
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{
    itemTop: number;
    itemLeft: number;
    itemRight: number;
  } | null>(null);
  const [hoverFinal, setHoverFinal] = useState<{ left: number; top: number } | null>(null);
  const [hoverReady, setHoverReady] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  // 镜像最新 selections，用于发送完成时判断用户是否已增删引用（避免误清新列表）
  const selectionsRef = useRef(selections);
  useEffect(() => {
    selectionsRef.current = selections;
  }, [selections]);

  /** 关闭悬停层（清理延迟关闭定时器） */
  const closeHover = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverIdx(null);
    setHoverPos(null);
    setHoverFinal(null);
    setHoverReady(false);
  };

  /** 悬停到条目：记录位置并显示完整内容层 */
  const openHover = (i: number, el: HTMLElement) => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const r = el.getBoundingClientRect();
    setHoverPos({ itemTop: r.top, itemLeft: r.left, itemRight: r.right });
    setHoverFinal(null);
    setHoverReady(false);
    setHoverIdx(i);
  };

  /** 离开条目：延迟关闭，留出移入弹出层的时间（hover 桥接） */
  const scheduleHoverClose = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHoverIdx(null);
      setHoverPos(null);
      setHoverFinal(null);
      setHoverReady(false);
    }, 180);
  };

  // 测量弹出层尺寸：优先显示在条目左侧（朝向 PDF 原文），左侧放不下则翻到右侧；
  // 垂直与条目顶对齐并夹紧在视口内，保证按钮始终可见
  useLayoutEffect(() => {
    if (hoverIdx == null || !hoverPos || !popoverRef.current) return;
    const el = popoverRef.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const leftSpace = hoverPos.itemLeft - 8;
    const rightSpace = window.innerWidth - hoverPos.itemRight - 8;
    let left: number;
    if (leftSpace >= w) {
      left = hoverPos.itemLeft - 8 - w;
    } else if (rightSpace >= w) {
      left = hoverPos.itemRight + 8;
    } else {
      left = 8; // 两侧都放不下：靠左夹紧
    }
    const top = Math.max(8, Math.min(hoverPos.itemTop, window.innerHeight - h - 8));
    setHoverFinal({ left, top });
    setHoverReady(true);
  }, [hoverIdx, hoverPos]);

  // 引用列表变化时关闭悬停层（条目可能被移除/换位）
  useEffect(() => {
    closeHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selections]);

  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    },
    [],
  );

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

  // 切换会话时重置流式/澄清状态
  useEffect(() => {
    setPending(null);
    setThinkingText("");
    setStreamingText("");
    setLiveTrace([]);
  }, [conversationId]);

  // 新消息滚动到底部（含流式增量）
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending, streamingText, thinkingText]);

  /** 实时事件分发：思考/正文增量、工具开始/完成 */
  function onAgentEvent(evt: AgentEvent) {
    switch (evt.type) {
      case "thinking":
        setThinkingText((t) => t + evt.text);
        break;
      case "content":
        setStreamingText((t) => t + evt.text);
        break;
      case "tool_start":
        setLiveTrace((prev) => [
          ...prev,
          { name: evt.name, args: evt.args, summary: "", running: true, elapsed_ms: 0 },
        ]);
        break;
      case "tool_end": {
        setLiveTrace((prev) => {
          // 结束最后一个同名 running 条目
          const idx = [...prev].reverse().findIndex((s) => s.name === evt.name && s.running);
          if (idx === -1) return prev;
          const real = prev.length - 1 - idx;
          const next = [...prev];
          next[real] = {
            ...next[real],
            running: false,
            summary: evt.summary,
            error: evt.error ?? undefined,
            elapsed_ms: evt.elapsed_ms,
          };
          return next;
        });
        break;
      }
    }
  }

  /** 提交澄清回答：续跑被 ask_user 中断的深度研究 */
  async function submitReply(reply: string) {
    if (!convId || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    setPending(null); // 移除澄清气泡（其轨迹并入 liveTrace 继续）
    setStreamingText("");
    setMessages((prev) => [...prev, { role: "user", content: reply }]);
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const ans = await askQuestionReply(convId, reply, webOn, ch);
      if (ans.pending) {
        // 防御：理论上每轮最多澄清一次，不会再次中断
        setPending(ans.pending);
        return;
      }
      setStreamingText("");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: ans.answer,
          citations: ans.citations,
          trace: ans.trace,
          timing: ans.timing,
        },
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  async function handleSend() {
    const question = input.trim();
    if (!question || sending) return;
    // 澄清待答：输入内容作为澄清回答提交
    if (pending) {
      void submitReply(question);
      return;
    }
    // 发送时捕获当前引用列表；仅成功后清空（且用户未增删引用）
    const sentSelections = selections;
    setInput("");
    setSending(true);
    setError(null);
    // 新一轮：重置流式状态
    setThinkingText("");
    setStreamingText("");
    setLiveTrace([]);
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const ans = await askQuestion(question, {
        paperId: paperId ?? null,
        conversationId: convId,
        selections: sentSelections,
        mode,
        webSearch: webOn,
        onEvent: ch,
      });
      if (ans.pending) {
        // 模型请求澄清：显示澄清气泡，等待用户作答
        setPending(ans.pending);
        if (!convId) {
          setConvId(ans.conversation_id);
          onConversationCreated?.(ans.conversation_id);
        }
        // 发送成功且引用区未被用户改动 → 自动清空（选中段落已随运行现场持久化）
        if (sentSelections?.length && selectionsRef.current === sentSelections) {
          onClearSelections?.();
        }
        return;
      }
      setStreamingText("");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: ans.answer,
          citations: ans.citations,
          trace: ans.trace,
          timing: ans.timing,
        },
      ]);
      if (!convId) {
        setConvId(ans.conversation_id);
        onConversationCreated?.(ans.conversation_id);
      }
      // 发送成功且引用区未被用户改动 → 自动清空
      if (sentSelections?.length && selectionsRef.current === sentSelections) {
        onClearSelections?.();
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
                  {/* 回答上方 meta 区：思考胶囊（本轮）+ 工具调用胶囊（均默认收纳，网页版风格） */}
                  {(m.role === "assistant" &&
                    i === messages.length - 1 &&
                    thinkingText) ||
                  (m.trace && m.trace.length > 0) ? (
                    // 默认 stretch：胶囊组件撑满气泡宽度，展开面板不溢出（items-start 会按内容收缩）
                    <div className="mb-2 flex flex-col gap-1.5">
                      {m.role === "assistant" && i === messages.length - 1 && thinkingText && (
                        <ThinkingPanel text={thinkingText} streaming={false} />
                      )}
                      {m.trace && m.trace.length > 0 && <ToolTrace trace={m.trace} />}
                    </div>
                  ) : null}
                  <AssistantBody
                    content={m.content}
                    citations={m.citations}
                    onOpenPaper={onOpenPaper}
                    onJumpPage={onJumpPage}
                  />
                  <TimingLine timing={m.timing} />
                </div>
              </div>
            ),
          )
        )}
        {/* AI 澄清气泡（ask_user）：问题 + 选项 chips + 自由输入提示 + 已执行工具轨迹 */}
        {pending && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
              <p className="text-sm font-medium">{pending.question}</p>
              {pending.options && pending.options.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pending.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => void submitReply(opt)}
                      className="pressable rounded-full border px-2.5 py-1 text-xs transition-colors hover:border-primary hover:text-primary"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {pending.free_text && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  也可以直接在下方输入框作答后发送
                </p>
              )}
              <div className="mt-2">
                <ToolTrace trace={liveTrace} />
              </div>
            </div>
          </div>
        )}
        {/* 实时生成区：思考胶囊（默认收纳）+ 工具轨迹 + 流式回答 */}
        {sending && (
          <>
            {thinkingText && <ThinkingPanel text={thinkingText} streaming />}
            {liveTrace.length > 0 && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
                  <ToolTrace trace={liveTrace} />
                </div>
              </div>
            )}
            {streamingText && (
              <div className="flex justify-start">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm">
                  {streamingText}
                </div>
              </div>
            )}
            {!thinkingText && liveTrace.length === 0 && !streamingText && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {mode === "agent" ? "AI 正在研读论文并检索资料…" : "检索并生成回答…"}
                  <LiveClock />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 阅读页选中的段落：引用区（淡灰卡片、13px 两行文本 + 左缘引文竖线；发送成功后自动清空） */}
      {selections && selections.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-muted-foreground">
              引用 {selections.length}
              {maxSelections && selections.length >= maxSelections && (
                <span className="ml-1">· 已满</span>
              )}
            </span>
            <button
              onClick={() => onClearSelections?.()}
              title="清空引用"
              className="pressable text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              清空
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {selections.map((sel, i) => (
              <div
                key={`${sel.pageIdx}:${sel.text.slice(0, 24)}`}
                className="animate-in fade-in -mx-1 flex items-start gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-accent/50"
                onMouseEnter={(e) => openHover(i, e.currentTarget)}
                onMouseLeave={scheduleHoverClose}
              >
                <div className="min-w-0 flex-1 border-l-2 border-foreground/10 pl-2">
                  <p className="line-clamp-2 text-[13px] leading-snug text-foreground/85">
                    {sel.text}
                  </p>
                </div>
                <button
                  onClick={() => onRemoveSelection?.(i)}
                  title="移除该条引用"
                  className="pressable shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 引用条目悬停层：完整内容 + 「跳转到原文」（显示在条目左侧，放不下翻到右侧） */}
      {hoverIdx != null && hoverPos && selections && selections[hoverIdx] && (
        <div
          ref={popoverRef}
          className="fixed z-50 w-80 max-w-[calc(100vw-16px)] rounded-lg border bg-popover p-3 shadow-md ring-1 ring-foreground/10"
          style={{
            left: hoverFinal?.left ?? 8,
            top: hoverFinal?.top ?? hoverPos.itemTop,
            visibility: hoverReady ? "visible" : "hidden",
          }}
          onMouseEnter={() => {
            if (hoverTimerRef.current !== null) {
              window.clearTimeout(hoverTimerRef.current);
              hoverTimerRef.current = null;
            }
          }}
          onMouseLeave={closeHover}
        >
          <p className="max-h-40 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85">
            {selections[hoverIdx].text}
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="text-[11px] text-muted-foreground">
              第 {selections[hoverIdx].pageIdx + 1} 页
            </span>
            <button
              onClick={() => {
                const sel = selections[hoverIdx];
                closeHover();
                onJumpToSelection?.(sel.pageIdx, sel.rects);
              }}
              className="pressable inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <FileSearch className="h-3.5 w-3.5" />
              跳转到原文
            </button>
          </div>
        </div>
      )}

      {/* 问答模式开关：快速（单轮 RAG）/ 深度（多步工具研究，默认） */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-full border bg-muted/50 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setMode("quick")}
            disabled={!!pending}
            title="单轮检索，快而省"
            className={`pressable rounded-full px-2.5 py-0.5 transition-colors ${
              mode === "quick"
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            } ${pending ? "cursor-not-allowed opacity-50" : ""}`}
          >
            快速
          </button>
          <button
            type="button"
            onClick={() => setMode("agent")}
            disabled={!!pending}
            title="AI 多角度研读论文并联网检索后再回答"
            className={`pressable rounded-full px-2.5 py-0.5 transition-colors ${
              mode === "agent"
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            } ${pending ? "cursor-not-allowed opacity-50" : ""}`}
          >
            深度
          </button>
        </div>
        <WebToggle on={webOn} onChange={setWebOn} configured={webConfigured} disabled={!!pending} />
        {pending && (
          <span className="text-[11px] text-muted-foreground">等待你回答 AI 的澄清问题</span>
        )}
      </div>

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
          placeholder={pending ? "回答 AI 的澄清问题…（Enter 发送）" : paperId ? "针对这篇论文提问…（Enter 发送，Shift+Enter 换行）" : "向整个论文库提问…（Enter 发送，Shift+Enter 换行）"}
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
