import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Reorder } from "motion/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { MarkdownView } from "@/components/MarkdownView";
import { LiveClock } from "@/components/LiveClock";
import { ThinkingPanel } from "@/components/ThinkingPanel";
import { TimingLine } from "@/components/TimingLine";
import { ToolTrace, type LiveToolStep } from "@/components/ToolTrace";
import { WebToggle } from "@/components/WebToggle";
import {
  feynmanConfirmPlan,
  feynmanJudge,
  feynmanNext,
  feynmanQuiz,
  feynmanReview,
  feynmanStart,
  feynmanTurn,
  getConversation,
  getFeynmanConversation,
  type ConceptStatus,
  type AgentEvent,
  type FeynmanMessage,
  type FeynmanState,
  type PlanItem,
  getSettings,
  isWebSearchConfigured,
} from "@/lib/api";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  ClipboardList,
  GraduationCap,
  GripVertical,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SendHorizonal,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

interface Props {
  paperId: string;
}

/** 计划草稿条目：在 PlanItem 之上附加本地唯一 id（仅草稿层使用，确认时剥离） */
interface PlanDraftItem {
  id: string;
  name: string;
  objective: string;
}

/** 为计划条目生成本地唯一 id */
function draftId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 概念状态 → 小图标 */
function statusIcon(status: ConceptStatus) {
  switch (status) {
    case "passed":
      return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
    case "weak":
      return <TriangleAlert className="h-3 w-3 text-amber-500" />;
    case "quiz":
    case "teaching":
      return <GraduationCap className="h-3 w-3 text-primary" />;
    default:
      return <Circle className="h-3 w-3 text-muted-foreground/50" />;
  }
}

/** 旧版单会话状态检测：plan 非空且所有概念均无 session_id */
function isLegacyState(fs: FeynmanState): boolean {
  return fs.plan.length > 0 && fs.concepts.every((c) => !c.session_id);
}

/**
 * 费曼学习法对话（概念级独立会话 + 摘要链）。
 * 每个概念一个独立会话窗口（概念 Tab），可随时切换回看；
 * 概念讲完（测验通过）自动生成完成摘要，供后续概念作为背景知识。
 * 旧版单会话（legacy）只读展示并提示重新开始。
 */
export function FeynmanChat({ paperId }: Props) {
  // 主行进度（feynman_state）
  const [fs, setFs] = useState<FeynmanState | null>(null);
  const [mainConvId, setMainConvId] = useState<string | null>(null);
  // 激活概念索引 + 各概念会话消息缓存
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [conceptMessages, setConceptMessages] = useState<Record<number, FeynmanMessage[]>>({});
  /** 每概念最近一轮的学生思考内容（仅实时展示，不持久化） */
  const [turnThinking, setTurnThinking] = useState<Record<number, string>>({});
  /** 实时流式状态：思考 / 回答增量 / 工具轨迹（生成中） */
  const [liveThinking, setLiveThinking] = useState("");
  const [liveText, setLiveText] = useState("");
  const [liveTrace, setLiveTrace] = useState<LiveToolStep[]>([]);
  /** 联网搜索开关（默认开；未配置 provider 时显示「未配置」提示） */
  const [webOn, setWebOn] = useState(true);
  const [webConfigured, setWebConfigured] = useState(true);

  // 挂载时读取联网搜索配置状态
  useEffect(() => {
    getSettings()
      .then((s) => setWebConfigured(isWebSearchConfigured(s)))
      .catch(() => {});
  }, []);
  const [loadingConcept, setLoadingConcept] = useState(false);
  // 旧版单会话（只读）
  const [legacy, setLegacy] = useState(false);
  const [legacyMessages, setLegacyMessages] = useState<FeynmanMessage[]>([]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [judging, setJudging] = useState(false);
  const [quizzing, setQuizzing] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [nexting, setNexting] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 计划编辑草稿（planning 阶段）
  const [planDraft, setPlanDraft] = useState<PlanDraftItem[]>([]);
  const [newName, setNewName] = useState("");
  const [newObjective, setNewObjective] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editObjective, setEditObjective] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 恢复该论文最近的费曼会话（主行 + 状态 + 当前概念消息）
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    getFeynmanConversation(paperId)
      .then(async (conv) => {
        if (cancelled || !conv) return;
        setMainConvId(conv.id);
        let parsed: FeynmanState | null = null;
        if (conv.feynman_state) {
          try {
            parsed = JSON.parse(conv.feynman_state) as FeynmanState;
          } catch {
            setError("闯关状态解析失败");
          }
        }
        if (!parsed) {
          // 旧版自由聊天会话（无状态）→ 空态
          setFs(null);
          return;
        }
        setFs(parsed);
        if (isLegacyState(parsed)) {
          // 旧版单会话：只读展示主行消息
          setLegacy(true);
          try {
            setLegacyMessages(JSON.parse(conv.messages) as FeynmanMessage[]);
          } catch {
            setError("会话历史解析失败");
          }
          return;
        }
        // 新机制：激活主线当前概念并加载其消息
        const idx = Math.min(parsed.current_index, parsed.plan.length - 1);
        setActiveIndex(idx);
        const sessionId = parsed.concepts[idx]?.session_id;
        if (sessionId) {
          try {
            const c = await getConversation(sessionId);
            if (!cancelled) {
              setConceptMessages((prev) => ({
                ...prev,
                [idx]: JSON.parse(c.messages) as FeynmanMessage[],
              }));
            }
          } catch {
            // 概念行缺失时留空（用户可重新开始）
          }
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  // planning 阶段：计划变化时同步可编辑草稿（附本地 id）
  useEffect(() => {
    if (fs?.status === "planning") {
      setPlanDraft(fs.plan.map((p) => ({ id: draftId(), name: p.name, objective: p.objective })));
    }
  }, [fs]);

  // 新消息 / 状态变化滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conceptMessages, activeIndex, sending, review, starting, judging, quizzing, nexting, planning, liveText, liveThinking, fs, legacyMessages]);

  // 派生状态
  const isPlanning = fs?.status === "planning" && !legacy;
  const activeIdx = activeIndex ?? (fs ? fs.current_index : null);
  const activeCs = fs && activeIdx !== null ? fs.concepts[activeIdx] : undefined;
  const activeMessages =
    legacy ? legacyMessages : activeIdx !== null ? (conceptMessages[activeIdx] ?? []) : [];
  /** 当前概念最近一轮的学生思考内容（渲染思考胶囊用） */
  const thinking = activeIdx !== null ? (turnThinking[activeIdx] ?? "") : "";
  const isQuiz = activeCs?.status === "quiz";
  const currentPassed = activeCs?.status === "passed";
  const currentWeak = activeCs?.status === "weak";
  const activeSessionId = fs && activeIdx !== null ? fs.concepts[activeIdx]?.session_id : null;
  const isMainLine = activeIdx !== null && fs ? activeIdx === fs.current_index : false;
  const canQuiz =
    !!activeSessionId &&
    (activeCs?.status === "teaching" || activeCs?.status === "weak") &&
    !sending &&
    !quizzing;
  const hasQuizAnswers = useMemo(() => {
    if (activeCs?.status !== "quiz") return false;
    const lastAssistant = [...activeMessages].map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistant === -1) return false;
    return activeMessages.slice(lastAssistant + 1).some((m) => m.role === "user");
  }, [activeCs, activeMessages]);
  const canJudge = isQuiz && hasQuizAnswers && !judging && !sending;

  /** 切换到某概念 Tab（懒加载其消息） */
  const switchConcept = useCallback(
    async (i: number) => {
      if (!fs || legacy) return;
      setActiveIndex(i);
      setReview(null);
      if (conceptMessages[i]) return;
      const sessionId = fs.concepts[i]?.session_id;
      if (!sessionId) return;
      setLoadingConcept(true);
      try {
        const c = await getConversation(sessionId);
        setConceptMessages((prev) => ({
          ...prev,
          [i]: JSON.parse(c.messages) as FeynmanMessage[],
        }));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoadingConcept(false);
      }
    },
    [fs, legacy, conceptMessages],
  );

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const turn = await feynmanStart(paperId);
      setMainConvId(turn.conversation_id);
      setFs(turn.state ?? null);
      setLegacy(false);
      setLegacyMessages([]);
      setActiveIndex(null);
      setConceptMessages({});
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function handleConfirmPlan() {
    if (!mainConvId || planDraft.length === 0 || planning) return;
    setPlanning(true);
    setError(null);
    try {
      const plan: PlanItem[] = planDraft.map(({ id: _id, ...rest }) => rest);
      resetLive();
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const turn = await feynmanConfirmPlan(mainConvId, plan, webOn, ch);
      setLiveText("");
      setFs(turn.state ?? null);
      // 创建了概念 0 会话行：初始化其消息（学生引导提问）
      if (turn.concept_session_id) {
        setActiveIndex(0);
        setConceptMessages((prev) => ({
          ...prev,
          0: turn.reply
            ? [{ role: "assistant", content: turn.reply, trace: turn.trace, timing: turn.timing }]
            : [],
        }));
        setTurnThinking((prev) => ({ ...prev, 0: turn.thinking ?? "" }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPlanning(false);
    }
  }

  /** 实时事件分发：思考/正文增量、工具开始/完成 */
  function onAgentEvent(evt: AgentEvent) {
    switch (evt.type) {
      case "thinking":
        setLiveThinking((t) => t + evt.text);
        break;
      case "content":
        setLiveText((t) => t + evt.text);
        break;
      case "tool_start":
        setLiveTrace((prev) => [
          ...prev,
          { name: evt.name, args: evt.args, summary: "", running: true, elapsed_ms: 0 },
        ]);
        break;
      case "tool_end": {
        setLiveTrace((prev) => {
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

  /** 新一轮：重置实时流式状态 */
  function resetLive() {
    setLiveThinking("");
    setLiveText("");
    setLiveTrace([]);
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending || !activeSessionId || activeIdx === null) return;
    const idx = activeIdx; // 捕获，防异步竞态
    setInput("");
    setSending(true);
    setError(null);
    setReview(null);
    resetLive();
    setConceptMessages((prev) => ({
      ...prev,
      [idx]: [...(prev[idx] ?? []), { role: "user", content }],
    }));
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const turn = await feynmanTurn(content, paperId, activeSessionId, webOn, ch);
      if (turn.reply) {
        setConceptMessages((prev) => ({
          ...prev,
          [idx]: [
            ...(prev[idx] ?? []),
            {
              role: "assistant",
              content: turn.reply,
              trace: turn.trace,
              timing: turn.timing,
            },
          ],
        }));
      }
      setTurnThinking((prev) => ({ ...prev, [idx]: turn.thinking ?? "" }));
      setLiveText("");
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  async function handleQuiz() {
    if (!activeSessionId || quizzing) return;
    const idx = activeIdx;
    setQuizzing(true);
    setError(null);
    setReview(null);
    resetLive();
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const turn = await feynmanQuiz(activeSessionId, webOn, ch);
      if (turn.reply && idx !== null) {
        setConceptMessages((prev) => ({
          ...prev,
          [idx]: [
            ...(prev[idx] ?? []),
            { role: "assistant", content: turn.reply, trace: turn.trace, timing: turn.timing },
          ],
        }));
        setTurnThinking((prev) => ({ ...prev, [idx]: turn.thinking ?? "" }));
        setLiveText("");
      }
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setQuizzing(false);
    }
  }

  async function handleJudge() {
    if (!activeSessionId || judging) return;
    const idx = activeIdx;
    setJudging(true);
    setError(null);
    setReview(null);
    resetLive();
    try {
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const turn = await feynmanJudge(activeSessionId, webOn, ch);
      if (turn.reply && idx !== null) {
        setConceptMessages((prev) => ({
          ...prev,
          [idx]: [
            ...(prev[idx] ?? []),
            { role: "assistant", content: turn.reply, trace: turn.trace, timing: turn.timing },
          ],
        }));
      }
      setLiveText("");
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setJudging(false);
    }
  }

  async function handleNext() {
    if (!activeSessionId || nexting) return;
    setNexting(true);
    setError(null);
    setReview(null);
    try {
      resetLive();
      const ch = new Channel<AgentEvent>();
      ch.onmessage = onAgentEvent;
      const turn = await feynmanNext(activeSessionId, webOn, ch);
      setLiveText("");
      setFs(turn.state ?? null);
      // 新概念会话行创建：切换到新 Tab 并初始化其消息（学生引导提问）
      if (turn.state && turn.concept_session_id) {
        const nextIdx = turn.state.current_index;
        setActiveIndex(nextIdx);
        setConceptMessages((prev) => ({
          ...prev,
          [nextIdx]: turn.reply
            ? [{ role: "assistant", content: turn.reply, trace: turn.trace, timing: turn.timing }]
            : [],
        }));
        setTurnThinking((prev) => ({ ...prev, [nextIdx]: turn.thinking ?? "" }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setNexting(false);
    }
  }

  async function handleReview() {
    if (!mainConvId || reviewing) return;
    setReviewing(true);
    setReview(null);
    setError(null);
    try {
      setReview(await feynmanReview(mainConvId));
    } catch (e) {
      setError(String(e));
    } finally {
      setReviewing(false);
    }
  }

  function handleRestart() {
    setFs(null);
    setMainConvId(null);
    setActiveIndex(null);
    setConceptMessages({});
    setLegacy(false);
    setLegacyMessages([]);
    setPlanDraft([]);
    setEditingId(null);
    setReview(null);
    setError(null);
  }

  // ---- 计划编辑（增删 / 拖动排序 / 内联编辑） ----
  function addPlanItem() {
    const name = newName.trim();
    if (!name) return;
    setPlanDraft((prev) => [
      ...prev,
      { id: draftId(), name, objective: newObjective.trim() },
    ]);
    setNewName("");
    setNewObjective("");
  }

  function removePlanItem(i: number) {
    const target = planDraft[i];
    if (target && editingId === target.id) setEditingId(null);
    setPlanDraft((prev) => prev.filter((_, idx) => idx !== i));
  }

  function startEdit(item: PlanDraftItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditObjective(item.objective);
  }

  function saveEdit() {
    const name = editName.trim();
    if (!name || !editingId) return;
    setPlanDraft((prev) =>
      prev.map((item) =>
        item.id === editingId ? { ...item, name, objective: editObjective.trim() } : item,
      ),
    );
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 顶部：概念 Tab 窗口 + 操作按钮 */}
      {fs && !isPlanning && !legacy && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-1 overflow-x-auto border-b">
            {fs.plan.map((p, i) => {
              const cs = fs.concepts[i];
              const active = i === activeIdx;
              return (
                <button
                  key={i}
                  onClick={() => void switchConcept(i)}
                  title={`${i + 1}. ${p.name}`}
                  className={`flex shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1.5 text-xs transition-colors ${
                    active
                      ? "border-border bg-card text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {statusIcon(cs.status)}
                  <span className="max-w-24 truncate">{i + 1}. {p.name}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRestart}
              disabled={sending || reviewing || judging}
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
              disabled={!mainConvId || reviewing || sending || isPlanning}
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
        </div>
      )}

      {/* 旧版会话提示 */}
      {legacy && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          ⚠️ 该会话来自旧版本（单会话模式），仅可查看。点击「重新开始」使用新的概念会话机制。
          <Button
            size="sm"
            variant="outline"
            className="pressable ml-2 h-6 gap-1 px-2 text-xs"
            onClick={handleRestart}
          >
            <RotateCcw className="h-3 w-3" />
            重新开始
          </Button>
        </div>
      )}

      {/* 当前激活概念状态条 */}
      {fs && !isPlanning && !legacy && activeCs && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
          {fs.status === "done" && fs.concepts.every((c) => c.status === "passed") ? (
            <span>🎉 全部概念已讲完！可以点击右上角「复盘」检查整体讲解质量。</span>
          ) : currentPassed ? (
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span>
                ✅ 「{fs.plan[activeIdx!]?.name}」已通过测验
                {isMainLine ? " —— 进入下一概念，或继续补充讲解。" : "（回看中，可继续补充讲解）。"}
              </span>
              {isMainLine && (
                <Button
                  size="sm"
                  variant="outline"
                  className="pressable h-6 gap-1 px-2 text-xs"
                  onClick={() => void handleNext()}
                  disabled={nexting}
                >
                  {nexting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  下一概念
                </Button>
              )}
            </div>
          ) : currentWeak ? (
            <div>
              <span>
                ⚠️ 「{fs.plan[activeIdx!]?.name}」还需补讲：请针对缺口再讲一遍，然后重新「测验我」。
              </span>
              {activeCs.weak_points.length > 0 && (
                <div className="mt-1 line-clamp-2 text-muted-foreground">
                  {activeCs.weak_points[0]}
                </div>
              )}
            </div>
          ) : isQuiz ? (
            <span>
              📝 学生已出题，请作答后点「交卷」；也可以继续补充讲解。
            </span>
          ) : (
            <span>
              🎯 概念 {activeIdx! + 1}/{fs.plan.length}：「{fs.plan[activeIdx!]?.name}」 ——
              学生已经提问，请围绕它讲解；讲完可以点「测验我」检验。
            </span>
          )}
        </div>
      )}

      {/* 计划确认卡片 */}
      {isPlanning && (
        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <GraduationCap className="h-4 w-4 text-primary" />
            教学计划
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              可增删、拖动排序、点铅笔编辑
            </span>
          </div>
          {planDraft.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              计划为空，请添加至少一个概念。
            </p>
          ) : (
            <Reorder.Group
              axis="y"
              values={planDraft}
              onReorder={setPlanDraft}
              className="flex max-h-48 flex-col gap-0.5 overflow-y-auto pr-0.5"
            >
              {planDraft.map((item, i) => {
                const editing = editingId === item.id;
                return (
                  <Reorder.Item
                    key={item.id}
                    value={item}
                    drag={editing ? false : true}
                    whileDrag={{ scale: 1.02, boxShadow: "0 4px 12px rgba(0,0,0,0.12)" }}
                    className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1 ${
                      editing
                        ? "bg-accent/60"
                        : "cursor-grab active:cursor-grabbing hover:bg-accent"
                    }`}
                  >
                    {editing ? (
                      <>
                        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="概念名"
                            autoFocus
                            className="h-7 text-sm"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                saveEdit();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                          <Input
                            value={editObjective}
                            onChange={(e) => setEditObjective(e.target.value)}
                            placeholder="教学目标（可选）"
                            className="h-7 text-sm"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                saveEdit();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                        </div>
                        <button
                          onClick={saveEdit}
                          disabled={!editName.trim()}
                          title="保存"
                          className="pressable rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={cancelEdit}
                          title="取消"
                          className="pressable rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
                        <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {i + 1}.
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{item.name}</p>
                          {item.objective && (
                            <p className="truncate text-xs text-muted-foreground">
                              {item.objective}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => startEdit(item)}
                          title="编辑"
                          className="pressable rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => removePlanItem(i)}
                          title="删除"
                          className="pressable rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </Reorder.Item>
                );
              })}
            </Reorder.Group>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="概念名"
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addPlanItem();
                }
              }}
            />
            <Input
              value={newObjective}
              onChange={(e) => setNewObjective(e.target.value)}
              placeholder="教学目标（可选）"
              className="h-8 min-w-0 flex-1 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addPlanItem();
                }
              }}
            />
            <Button
              size="icon"
              variant="outline"
              className="pressable h-8 w-8 shrink-0"
              onClick={addPlanItem}
              disabled={!newName.trim()}
              title="添加概念"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <Button
            className="pressable mt-2 w-full"
            onClick={() => void handleConfirmPlan()}
            disabled={planDraft.length === 0 || planning}
          >
            {planning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            确认计划，开始闯关
          </Button>
        </div>
      )}

      {/* 消息区 */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2">
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载会话…
          </div>
        ) : starting ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">正在通读论文、制定教学计划…</p>
          </div>
        ) : loadingConcept ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载概念会话…
          </div>
        ) : !fs ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center text-muted-foreground">
            <GraduationCap className="h-10 w-10" />
            <p className="max-w-md text-sm">
              用费曼学习法把这篇论文讲明白：AI 先生成一份概念教学计划，每个概念一个独立会话，
              逐个讲解，学生追问并用测验检验你是否真的讲透了。
            </p>
            <Button
              onClick={() => void handleStart()}
              disabled={starting}
              className="pressable gap-2"
            >
              <Play className="h-4 w-4" />
              AI 制定教学计划
            </Button>
          </div>
        ) : activeMessages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {isPlanning ? "确认计划后开始第一个概念。" : "该概念会话暂无消息。"}
          </div>
        ) : (
          activeMessages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
                  {/* 回答上方 meta 区：思考胶囊（本轮）+ 工具调用胶囊（均默认收纳） */}
                  {(m.role === "assistant" &&
                    i === activeMessages.length - 1 &&
                    thinking) ||
                  (m.trace && m.trace.length > 0) ? (
                    <div className="mb-2 flex flex-col gap-1.5">
                      {m.role === "assistant" &&
                        i === activeMessages.length - 1 &&
                        thinking && (
                          <ThinkingPanel text={thinking} streaming={false} />
                        )}
                      {m.trace && m.trace.length > 0 && <ToolTrace trace={m.trace} />}
                    </div>
                  ) : null}
                  <MarkdownView markdown={m.content} className="prose-sm" />
                  <TimingLine timing={m.timing} />
                </div>
              </div>
            ),
          )
        )}
        {/* 实时生成区：思考胶囊（默认收纳）+ 工具卡片 + 流式回答；无实时内容时显示加载提示 */}
        {(sending || quizzing || judging || nexting || planning) && (
          <>
            {liveThinking && <ThinkingPanel text={liveThinking} streaming />}
            {liveTrace.length > 0 && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
                  <ToolTrace trace={liveTrace} />
                </div>
              </div>
            )}
            {liveText && (
              <div className="flex justify-start">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm">
                  {liveText}
                </div>
              </div>
            )}
            {!liveThinking && liveTrace.length === 0 && !liveText && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  学生正在研读论文并思考…
                  <LiveClock />
                </div>
              </div>
            )}
          </>
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

      {/* 输入区：测验/交卷按钮 + 发送（legacy 只读禁用） */}
      <div className="mb-1.5">
        <WebToggle
          on={webOn}
          onChange={setWebOn}
          configured={webConfigured}
          disabled={legacy || !activeSessionId}
        />
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
          disabled={legacy || !activeSessionId}
          placeholder={
            legacy
              ? "旧版会话仅可查看"
              : !activeSessionId
                ? "先制定教学计划并确认，开始闯关"
                : isQuiz
                  ? "作答测验题…（答完点「交卷」）"
                  : "讲解你理解的论文概念…（Enter 发送，Shift+Enter 换行）"
          }
          className="min-h-11 flex-1 resize-none"
          rows={1}
        />
        {canQuiz && (
          <Button
            size="icon"
            variant="outline"
            onClick={() => void handleQuiz()}
            disabled={quizzing}
            title="学生出题，检验当前概念是否讲明白"
            className="pressable h-11 w-11 shrink-0"
          >
            {quizzing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ClipboardList className="h-4 w-4" />
            )}
          </Button>
        )}
        {isQuiz && (
          <Button
            size="icon"
            variant="outline"
            onClick={() => void handleJudge()}
            disabled={!canJudge}
            title={hasQuizAnswers ? "交卷并判定" : "先在对话中作答测验题"}
            className="pressable h-11 w-11 shrink-0"
          >
            {judging ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </Button>
        )}
        <Button
          size="icon"
          onClick={() => void handleSend()}
          disabled={sending || !input.trim() || legacy || !activeSessionId}
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
