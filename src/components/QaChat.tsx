import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { ChatComposer } from "@/components/ChatComposer";
import { CitationBadge } from "@/components/CitationBadge";
import { LiveClock } from "@/components/LiveClock";
import { ThinkingPanel } from "@/components/ThinkingPanel";
import { TimingLine } from "@/components/TimingLine";
import { ToolTrace, type LiveToolStep } from "@/components/ToolTrace";
import {
  katexOptions,
  linkifyCitations,
  markdownUrlTransform,
  normalizeImageUrls,
  normalizeLatex,
  resolveImgSrc,
} from "@/lib/markdown";
import { WebToggle } from "@/components/WebToggle";
import { useStickyScroll } from "@/hooks/useStickyScroll";
import {
  askQuestion,
  askQuestionReply,
  cancelGeneration,
  getConversation,
  getSettings,
  isWebSearchConfigured,
  type AgentEvent,
  type AnnotationRect,
  type Citation,
  type PendingAsk,
  type QaMessage,
} from "@/lib/api";
import { ArrowDown, FileSearch, Loader2, MessageSquare, X } from "lucide-react";

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
  /** 阅读页选中的段落列表（上下文引用区，可多条；提交后立即清空并附着到消息气泡） */
  selections?: {
    text: string;
    /** 0-based 页码；博客/译文划选为 null */
    pageIdx: number | null;
    rects?: AnnotationRect[];
    /** 人类可读来源位置（博客/译文划选），PDF 划选不传 */
    location?: string;
  }[] | null;
  onClearSelections?: () => void;
  /** 移除第 i 条引用 */
  onRemoveSelection?: (index: number) => void;
  /** 点击历史消息上的引用：重新加回输入框引用区 */
  onRequoteSelection?: (sel: {
    text: string;
    pageIdx: number | null;
    location?: string;
  }) => void;
  /** 发送失败时把已捕获的引用批量恢复到输入框引用区 */
  onRestoreSelections?: (
    sels: { text: string; pageIdx: number | null; location?: string }[],
  ) => void;
  /** 引用条数上限（达到时在头部提示） */
  maxSelections?: number;
  /** 引用悬停层「跳转到原文」：跳回 PDF 选中段落所在位置 */
  onJumpToSelection?: (pageIdx: number, rects?: AnnotationRect[]) => void;
  /** 发送状态变化回调（供外层在生成期间禁用会话切换等操作） */
  onSendingChange?: (sending: boolean) => void;
}

interface AssistantBodyProps {
  content: string;
  citations: Citation[] | null | undefined;
  onOpenPaper?: (paperId: string, pageIdx?: number) => void;
  onJumpPage?: (pageIdx: number) => void;
  /** 阅读页会话绑定的论文 id（区分引用来源「本篇/他篇」） */
  currentPaperId?: string | null;
}

function AssistantBody({ content, citations, onOpenPaper, onJumpPage, currentPaperId }: AssistantBodyProps) {
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
                  currentPaperId={currentPaperId}
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

export function QaChat({ paperId, conversationId, onOpenPaper, onJumpPage, onConversationCreated, selections, onClearSelections, onRemoveSelection, onRequoteSelection, onRestoreSelections, maxSelections, onJumpToSelection, onSendingChange }: Props) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 发送状态上报（外层据此禁用会话切换等操作）
  useEffect(() => {
    onSendingChange?.(sending);
  }, [sending, onSendingChange]);
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
  // 吸底滚动：用户上翻时停止跟随，浮出「回到底部」
  const { scrollRef, atBottom, onScroll, scrollToBottom, stick } = useStickyScroll([
    messages,
    sending,
    streamingText,
    thinkingText,
  ]);
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
  /** 本次发送生成的取消令牌：「暂停」按钮据此中止生成（每次发送重新生成） */
  const cancelTokenRef = useRef<string | null>(null);
  /** 本轮被用户暂停：显示「已暂停」提示（下次发送清除） */
  const [pausedNote, setPausedNote] = useState(false);

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

  // 新消息滚动到底部由 useStickyScroll 承担（仅贴底时跟随）

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
    setPausedNote(false);
    cancelTokenRef.current = crypto.randomUUID();
    setMessages((prev) => [...prev, { role: "user", content: reply }]);
    stick(); // 自己发送：恢复吸附，滚到底
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const ans = await askQuestionReply(convId, reply, webOn, cancelTokenRef.current, ch);
      if (ans.pending) {
        // 防御：理论上每轮最多澄清一次，不会再次中断
        setPending(ans.pending);
        return;
      }
      if (ans.cancelled) setPausedNote(true);
      setStreamingText("");
      if (ans.answer.trim()) {
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
      }
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
    // 发送时捕获当前引用列表：附着到用户消息气泡，并立即清空输入框引用区
    const sentSelections = selections?.length ? selections : null;
    setInput("");
    setSending(true);
    setError(null);
    setPausedNote(false);
    cancelTokenRef.current = crypto.randomUUID();
    // 新一轮：重置流式状态
    setThinkingText("");
    setStreamingText("");
    setLiveTrace([]);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question, selections: sentSelections },
    ]);
    stick(); // 自己发送：恢复吸附，滚到底
    if (sentSelections) onClearSelections?.();
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const ans = await askQuestion(question, {
        paperId: paperId ?? null,
        conversationId: convId,
        selections: sentSelections,
        mode,
        webSearch: webOn,
        cancelToken: cancelTokenRef.current,
        onEvent: ch,
      });
      if (ans.pending) {
        // 模型请求澄清：显示澄清气泡，等待用户作答
        setPending(ans.pending);
        if (!convId) {
          setConvId(ans.conversation_id);
          onConversationCreated?.(ans.conversation_id);
        }
        return;
      }
      if (ans.cancelled) setPausedNote(true);
      setStreamingText("");
      if (ans.answer.trim()) {
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
      }
      if (!convId) {
        setConvId(ans.conversation_id);
        onConversationCreated?.(ans.conversation_id);
      }
    } catch (e) {
      // 发送失败：引用恢复到输入框引用区，避免用户丢失上下文
      if (sentSelections) onRestoreSelections?.(sentSelections);
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2"
      >
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载会话…
          </div>
        ) : messages.length === 0 && !sending ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              {paperId
                ? "就这篇论文提问，回答会优先依据本篇内容并附原文引用"
                : "跨论文提问，回答会附原文引用"}
            </p>
            <div className="flex max-w-md flex-wrap items-center justify-center gap-1.5">
              {(paperId
                ? ["这篇论文的核心贡献是什么？", "用通俗的话解释论文的方法", "论文的实验结论可靠吗？"]
                : ["帮我总结论文库的研究主题", "哪些论文的方法可以对比？", "推荐一篇适合入门的论文"]
              ).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInput(s)}
                  className="pressable rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className={`zp-msg-in flex justify-end ${
                  i > 0 ? "mt-1 border-t border-border/50 pt-4" : ""
                }`}
              >
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground shadow-sm">
                  {/* 提交时携带的引用：附着展示，点击重新加回输入框引用区 */}
                  {m.selections && m.selections.length > 0 && (
                    <div className="mb-1.5 flex flex-col gap-1">
                      {m.selections.map((sel, si) => (
                        <button
                          key={si}
                          type="button"
                          title="点击重新引用"
                          onClick={() =>
                            onRequoteSelection?.({
                              text: sel.text,
                              pageIdx: sel.pageIdx,
                              location: sel.location,
                            })
                          }
                          className="pressable rounded-md bg-primary-foreground/10 px-2 py-1 text-left transition-colors hover:bg-primary-foreground/20"
                        >
                          <p className="line-clamp-1 border-l-2 border-primary-foreground/30 pl-1.5 text-[12px] leading-snug text-primary-foreground/85">
                            {sel.text}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                  {m.content}
                </div>
              </div>
            ) : (
              /* AI 回答：通栏无气泡，长文/公式直接排版；轮次分隔由用户消息的上缘线承担 */
              <div key={i} className="zp-msg-in">
                {/* 回答上方 meta 区：思考胶囊（本轮）+ 工具调用胶囊（均默认收纳） */}
                {(m.role === "assistant" &&
                  i === messages.length - 1 &&
                  thinkingText) ||
                (m.trace && m.trace.length > 0) ? (
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
                  currentPaperId={paperId ?? null}
                />
                <TimingLine timing={m.timing} />
              </div>
            ),
          )
        )}
        {/* AI 澄清气泡（ask_user）：卡片 + 点缀色左缘；问题 + 选项 chips + 已执行工具轨迹 */}
        {pending && (
          <div className="zp-msg-in flex justify-start">
            <div className="w-full max-w-[95%] rounded-xl border border-l-2 border-l-zp-ai/60 bg-card px-4 py-3">
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
        {/* 实时生成区：思考胶囊 + 工具轨迹 + 流式回答（通栏，与最终形态一致） */}
        {sending && (
          <div className="zp-msg-in flex flex-col gap-2">
            {thinkingText && <ThinkingPanel text={thinkingText} streaming />}
            {liveTrace.length > 0 && <ToolTrace trace={liveTrace} />}
            {streamingText && (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">
                {streamingText}
                <span className="animate-pulse text-zp-ai">▍</span>
              </div>
            )}
            {!thinkingText && liveTrace.length === 0 && !streamingText && (
              <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="zp-typing-dot h-1.5 w-1.5 rounded-full bg-zp-ai" />
                  <span className="zp-typing-dot h-1.5 w-1.5 rounded-full bg-zp-ai" />
                  <span className="zp-typing-dot h-1.5 w-1.5 rounded-full bg-zp-ai" />
                </span>
                {mode === "agent" ? "AI 正在研读论文并检索资料…" : "检索并生成回答…"}
                <LiveClock />
              </div>
            )}
          </div>
        )}
        {/* 已暂停提示（本轮被用户暂停且无正文可提交时） */}
        {pausedNote && !sending && (
          <div className="flex justify-center">
            <span className="text-[11px] text-muted-foreground">已暂停</span>
          </div>
        )}
      </div>
      {/* 回到底部：上翻阅读时浮出，点击恢复吸附 */}
      {!atBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          title="回到底部"
          className="zp-msg-in pressable absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition-colors hover:text-foreground"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
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
              {selections[hoverIdx].location ??
                (selections[hoverIdx].pageIdx != null
                  ? `第 ${selections[hoverIdx].pageIdx + 1} 页`
                  : "")}
            </span>
            {selections[hoverIdx].pageIdx != null && (
              <button
                onClick={() => {
                  const sel = selections[hoverIdx];
                  closeHover();
                  // 守卫已保证 pageIdx 非空（博客/译文划选为 null 时不显示该按钮）
                  onJumpToSelection?.(sel.pageIdx!, sel.rects);
                }}
                className="pressable inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <FileSearch className="h-3.5 w-3.5" />
                跳转到原文
              </button>
            )}
          </div>
        </div>
      )}

      {/* 一体化输入壳：引用 chips（顶部）+ 输入框 + 底部工具行（模式/联网 + 发送） */}
      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={() => void handleSend()}
        sending={sending}
        onStop={() => {
          if (cancelTokenRef.current) void cancelGeneration(cancelTokenRef.current);
        }}
        sendDisabled={!input.trim()}
        placeholder={pending ? "回答 AI 的澄清问题…（Enter 发送）" : paperId ? "针对这篇论文提问…（Enter 发送，Shift+Enter 换行）" : "向整个论文库提问…（Enter 发送，Shift+Enter 换行）"}
        attachments={
          selections && selections.length > 0 ? (
            <div className="flex flex-col gap-1 border-b px-3 pt-2 pb-1.5">
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
              <div className="flex flex-col gap-0.5">
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
          ) : undefined
        }
        left={
          <>
            {/* 问答模式开关：快速（单轮 RAG）/ 深度（多步工具研究，默认） */}
            <div className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5 text-[11px]">
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
          </>
        }
      />
    </div>
  );
}
