import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { MarkdownView } from "@/components/MarkdownView";
import {
  feynmanConfirmPlan,
  feynmanJudge,
  feynmanNext,
  feynmanQuiz,
  feynmanReview,
  feynmanStart,
  feynmanTurn,
  getFeynmanConversation,
  type ConceptStatus,
  type FeynmanMessage,
  type FeynmanState,
  type PlanItem,
} from "@/lib/api";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  GraduationCap,
  GripVertical,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SendHorizonal,
  Trash2,
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

const statusMeta: Record<
  ConceptStatus | "quiz" | "done",
  { label: string; dot: string; pulse?: boolean }
> = {
  passed: { label: "已掌握", dot: "bg-emerald-500" },
  weak: { label: "需要补讲", dot: "bg-amber-500" },
  teaching: { label: "正在讲解", dot: "bg-indigo-500", pulse: true },
  pending: { label: "未开始", dot: "bg-muted-foreground/25" },
  quiz: { label: "正在回答", dot: "bg-violet-500", pulse: true },
  done: { label: "全部完成", dot: "bg-emerald-500" },
};

function StatusDot({
  status,
  className,
}: {
  status: ConceptStatus | "quiz" | "done";
  className?: string;
}) {
  const meta = statusMeta[status];
  return (
    <span
      className={`relative inline-flex h-2 w-2 rounded-full ${meta.dot} ${className ?? ""}`}
    >
      {meta.pulse && (
        <span
          className={`absolute inset-[-2px] rounded-full ${meta.dot} opacity-40 motion-safe:animate-ping`}
        />
      )}
    </span>
  );
}

/** 顶部学习进度头部 */
function ProgressHeader({
  fs,
  allDone,
  currentConcept,
  currentStatus,
  onRestart,
  onReview,
  reviewing,
}: {
  fs: FeynmanState;
  allDone: boolean;
  currentConcept?: PlanItem;
  currentStatus: ConceptStatus | "quiz" | "done";
  onRestart: () => void;
  onReview: () => void;
  reviewing: boolean;
}) {
  const meta = statusMeta[currentStatus];
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border bg-card/50 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            概念 {fs.current_index + 1}/{fs.plan.length}
          </span>
          <span className="text-border">·</span>
          <StatusDot status={currentStatus} />
          <span>{meta.label}</span>
        </div>
        <p className="truncate text-sm font-medium text-foreground">
          {allDone ? "学习完成" : currentConcept?.name}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={onRestart}
          className="pressable text-muted-foreground"
        >
          <RotateCcw className="h-3 w-3" />
          重新开始
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => void onReview()}
          disabled={reviewing}
          className="pressable"
        >
          {reviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          学习总结
        </Button>
      </div>
    </div>
  );
}

/** 一句话状态描述 */
function StatusDescription({
  allDone,
  currentConcept,
  currentCs,
  isQuiz,
}: {
  allDone: boolean;
  currentConcept?: PlanItem;
  currentCs?: { status: ConceptStatus; weak_points: string[] };
  isQuiz: boolean;
}) {
  if (allDone) {
    return (
      <p className="text-xs text-muted-foreground">
        全部概念已讲解完成，可以点击右上角「学习总结」回顾整体理解。
      </p>
    );
  }

  const name = currentConcept?.name ?? "";

  if (isQuiz) {
    return (
      <p className="text-xs text-muted-foreground">
        正在回答「{name}」的问题 —— 写完后点击「提交答案」。
      </p>
    );
  }

  const status = currentCs?.status;
  if (status === "passed") {
    return (
      <p className="text-xs text-muted-foreground">
        「{name}」已掌握 —— 可以继续补充讲解，或进入下一概念。
      </p>
    );
  }
  if (status === "weak") {
    return (
      <div className="flex flex-col gap-0.5">
        <p className="text-xs text-muted-foreground">
          「{name}」还需要补讲 —— 针对缺口再讲一遍，然后点击「出几道题」。
        </p>
        {currentCs && currentCs.weak_points.length > 0 && (
          <p className="line-clamp-2 text-[11px] text-amber-600/80 dark:text-amber-400/80">
            {currentCs.weak_points[0]}
          </p>
        )}
      </div>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      正在讲解「{name}」—— 讲完后可以点击「出几道题」检验理解。
    </p>
  );
}

/** 计划编辑卡片 */
function PlanEditor({
  planDraft,
  setPlanDraft,
  onConfirm,
  confirming,
}: {
  planDraft: PlanDraftItem[];
  setPlanDraft: (items: PlanDraftItem[]) => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editObjective, setEditObjective] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newObjective, setNewObjective] = useState("");

  function startEdit(item: PlanDraftItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditObjective(item.objective);
  }

  function saveEdit() {
    const name = editName.trim();
    if (!name || !editingId) return;
    setPlanDraft(
      planDraft.map((item) =>
        item.id === editingId ? { ...item, name, objective: editObjective.trim() } : item,
      ),
    );
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function addItem() {
    const name = newName.trim();
    if (!name) return;
    setPlanDraft([
      ...planDraft,
      { id: draftId(), name, objective: newObjective.trim() },
    ]);
    setNewName("");
    setNewObjective("");
    setAdding(false);
  }

  function removeItem(i: number) {
    const target = planDraft[i];
    if (target && editingId === target.id) setEditingId(null);
    setPlanDraft(planDraft.filter((_, idx) => idx !== i));
  }

  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10">
          <GraduationCap className="h-4 w-4 text-indigo-500" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-medium">概念计划</span>
          <span className="text-[11px] text-muted-foreground">
            调整顺序、增删概念，确认后开始讲解
          </span>
        </div>
      </div>

      {planDraft.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          还没有概念，先添加一个要讲解的主题。
        </p>
      ) : (
        <Reorder.Group
          axis="y"
          values={planDraft}
          onReorder={setPlanDraft}
          className="flex max-h-52 flex-col gap-1 overflow-y-auto pr-0.5"
        >
          <AnimatePresence initial={false}>
            {planDraft.map((item, i) => {
              const editing = editingId === item.id;
              return (
                <Reorder.Item
                  key={item.id}
                  value={item}
                  drag={editing ? false : true}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  whileDrag={{ scale: 1.01, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
                  className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                    editing
                      ? "bg-accent/60"
                      : "cursor-grab active:cursor-grabbing hover:bg-accent/50"
                  }`}
                >
                  {editing ? (
                    <>
                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
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
                        className="pressable rounded p-1 text-muted-foreground opacity-0 transition-colors hover:text-foreground group-hover:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => removeItem(i)}
                        title="删除"
                        className="pressable rounded p-1 text-muted-foreground opacity-0 transition-colors hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </Reorder.Item>
              );
            })}
          </AnimatePresence>
        </Reorder.Group>
      )}

      <AnimatePresence mode="popLayout" initial={false}>
        {adding ? (
          <motion.div
            key="add-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="mt-2 flex flex-col gap-1.5 overflow-hidden"
          >
            <div className="flex items-center gap-1.5">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="概念名"
                className="h-8 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addItem();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setAdding(false);
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
                    addItem();
                  }
                }}
              />
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setAdding(false)}
                className="pressable"
              >
                取消
              </Button>
              <Button
                size="xs"
                onClick={addItem}
                disabled={!newName.trim()}
                className="pressable"
              >
                添加
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="add-trigger"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={() => setAdding(true)}
            className="pressable mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            添加概念
          </motion.button>
        )}
      </AnimatePresence>

      <Button
        className="pressable mt-3 w-full"
        onClick={() => void onConfirm()}
        disabled={planDraft.length === 0 || confirming}
      >
        {confirming ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        确认计划，开始讲解
      </Button>
    </div>
  );
}

/** 消息项 */
function ChatMessage({ message }: { message: FeynmanMessage }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`${isUser ? "max-w-[80%]" : "max-w-[85%]"}`}>
        {!isUser && (
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <GraduationCap className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">学习助手</span>
          </div>
        )}
        <div
          className={`px-4 py-2.5 text-sm ${
            isUser
              ? "whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary text-primary-foreground"
              : "rounded-2xl rounded-bl-sm bg-muted"
          }`}
        >
          {isUser ? (
            message.content
          ) : (
            <MarkdownView markdown={message.content} className="prose-sm" />
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** 学习总结卡片 */
function ReviewCard({ review }: { review: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
      className="flex justify-start"
    >
      <div className="max-w-[90%] rounded-2xl border bg-card/60 px-4 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <GraduationCap className="h-3.5 w-3.5 text-muted-foreground" />
          学习总结
        </div>
        <MarkdownView markdown={review} className="prose-sm" />
      </div>
    </motion.div>
  );
}

/**
 * 费曼学习法对话：用户扮演老师讲解论文概念，AI 扮演学习助手。
 * 流程：AI 生成概念计划（可编辑确认）→ 逐概念讲解 → 追问 → 测验 → 判定 → 全部完成总结。
 * 旧会话（无 feynmanState）保持自由聊天模式，不显示计划学习 UI。
 */
export function FeynmanChat({ paperId }: Props) {
  const [messages, setMessages] = useState<FeynmanMessage[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [fs, setFs] = useState<FeynmanState | null>(null);
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
  const [planDraft, setPlanDraft] = useState<PlanDraftItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 恢复该论文最近的费曼会话（含状态）
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
        if (conv.feynman_state) {
          try {
            setFs(JSON.parse(conv.feynman_state) as FeynmanState);
          } catch {
            setError("学习状态解析失败");
          }
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  // planning 阶段：计划变化时同步可编辑草稿
  useEffect(() => {
    if (fs?.status === "planning") {
      setPlanDraft(fs.plan.map((p) => ({ id: draftId(), name: p.name, objective: p.objective })));
    }
  }, [fs]);

  // 新消息 / 状态变化滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending, review, starting, judging, quizzing, fs]);

  // 派生状态
  const isPlanning = fs?.status === "planning";
  const isQuiz = fs?.status === "quiz";
  const allDone = fs?.status === "done";
  const currentConcept = fs ? fs.plan[fs.current_index] : undefined;
  const currentCs = fs ? fs.concepts[fs.current_index] : undefined;
  const currentPassed = currentCs?.status === "passed";
  const canQuiz =
    !!convId && fs?.status === "teaching" && !currentPassed && !sending && !quizzing;
  const hasQuizAnswers = useMemo(() => {
    if (fs?.status !== "quiz") return false;
    const lastAssistant = [...messages].map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistant === -1) return false;
    return messages.slice(lastAssistant + 1).some((m) => m.role === "user");
  }, [fs, messages]);
  const canJudge = isQuiz && hasQuizAnswers && !judging && !sending;

  const currentStatus: ConceptStatus | "quiz" | "done" = useMemo(() => {
    if (allDone) return "done";
    if (isQuiz) return "quiz";
    return currentCs?.status ?? "pending";
  }, [allDone, isQuiz, currentCs?.status]);

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const turn = await feynmanStart(paperId);
      setConvId(turn.conversation_id);
      if (turn.reply) {
        setMessages([{ role: "assistant", content: turn.reply }]);
      } else {
        setMessages([]);
      }
      setFs(turn.state ?? null);
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
      if (turn.reply) {
        setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      }
      if (!convId) setConvId(turn.conversation_id);
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  async function handleConfirmPlan() {
    if (!convId || planDraft.length === 0 || planning) return;
    setPlanning(true);
    setError(null);
    try {
      const plan: PlanItem[] = planDraft.map(({ id: _id, ...rest }) => rest);
      const turn = await feynmanConfirmPlan(convId, plan);
      if (turn.reply) {
        setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      }
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setPlanning(false);
    }
  }

  async function handleQuiz() {
    if (!convId || quizzing) return;
    setQuizzing(true);
    setError(null);
    setReview(null);
    try {
      const turn = await feynmanQuiz(convId);
      if (turn.reply) {
        setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      }
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setQuizzing(false);
    }
  }

  async function handleJudge() {
    if (!convId || judging) return;
    setJudging(true);
    setError(null);
    setReview(null);
    try {
      const turn = await feynmanJudge(convId);
      if (turn.reply) {
        setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      }
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setJudging(false);
    }
  }

  async function handleNext() {
    if (!convId || nexting) return;
    setNexting(true);
    setError(null);
    try {
      const turn = await feynmanNext(convId);
      if (turn.reply) {
        setMessages((prev) => [...prev, { role: "assistant", content: turn.reply }]);
      }
      setFs(turn.state ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setNexting(false);
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
    setFs(null);
    setPlanDraft([]);
    setReview(null);
    setError(null);
    setInput("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 学习进度头部 */}
      {fs && !isPlanning && messages.length > 0 && (
        <ProgressHeader
          fs={fs}
          allDone={allDone}
          currentConcept={currentConcept}
          currentStatus={currentStatus}
          onRestart={handleRestart}
          onReview={handleReview}
          reviewing={reviewing}
        />
      )}

      {/* 当前状态描述 */}
      {fs && !isPlanning && (
        <div className="rounded-lg border bg-card/40 px-3 py-2">
          <StatusDescription
            allDone={allDone}
            currentConcept={currentConcept}
            currentCs={currentCs}
            isQuiz={isQuiz}
          />
        </div>
      )}

      {/* 计划编辑 */}
      {isPlanning && (
        <PlanEditor
          planDraft={planDraft}
          setPlanDraft={setPlanDraft}
          onConfirm={handleConfirmPlan}
          confirming={planning}
        />
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
            <p className="text-sm">正在阅读论文、整理概念计划…</p>
          </div>
        ) : messages.length === 0 ? (
          fs ? null : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12 text-center text-muted-foreground">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                <GraduationCap className="h-7 w-7" />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">
                  把论文讲成自己的知识
                </p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  先生成一份概念计划，再逐个讲解，直到能回答针对每个概念提出的问题。
                </p>
              </div>
              <Button
                onClick={() => void handleStart()}
                disabled={starting}
                className="pressable gap-2"
              >
                <Play className="h-4 w-4" />
                生成概念计划
              </Button>
            </div>
          )
        ) : (
          messages.map((m, i) => <ChatMessage key={i} message={m} />)
        )}

        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              思考中…
            </div>
          </div>
        )}

        {review && <ReviewCard review={review} />}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 输入区：按情境显示不同操作 */}
      {!isPlanning && (
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (isQuiz && canJudge) {
                  void handleJudge();
                } else if (input.trim()) {
                  void handleSend();
                }
              }
            }}
            placeholder={
              allDone
                ? "全部概念已讲解完成"
                : isQuiz
                  ? canJudge
                    ? "可以补充答案，或按 Enter 提交"
                    : "写下你的答案…（Enter 发送）"
                  : "讲解你理解的论文概念…（Enter 发送，Shift+Enter 换行）"
            }
            disabled={allDone}
            className="min-h-11 flex-1 resize-none"
            rows={1}
          />

          {allDone ? (
            <Button
              onClick={() => void handleReview()}
              disabled={reviewing}
              className="pressable h-11 gap-2 px-4"
            >
              {reviewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GraduationCap className="h-4 w-4" />
              )}
              学习总结
            </Button>
          ) : isQuiz ? (
            <Button
              size="icon"
              onClick={() => {
                if (canJudge) {
                  void handleJudge();
                } else if (input.trim()) {
                  void handleSend();
                }
              }}
              disabled={(!canJudge && !input.trim()) || judging || sending}
              title={canJudge ? "提交答案" : "发送答案"}
              className="pressable h-11 w-11"
            >
              {judging || sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : canJudge ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <SendHorizonal className="h-4 w-4" />
              )}
            </Button>
          ) : currentPassed ? (
            <>
              <Button
                size="icon"
                variant="outline"
                onClick={() => void handleSend()}
                disabled={sending || !input.trim()}
                title="发送补充讲解"
                className="pressable h-11 w-11 shrink-0"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SendHorizonal className="h-4 w-4" />
                )}
              </Button>
              <Button
                onClick={() => void handleNext()}
                disabled={nexting}
                className="pressable h-11 gap-2 px-3"
              >
                {nexting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                下一概念
              </Button>
            </>
          ) : (
            <>
              {canQuiz && (
                <Button
                  variant="outline"
                  onClick={() => void handleQuiz()}
                  disabled={quizzing}
                  title="针对当前概念出几道题"
                  className="pressable h-11 gap-1.5 px-3 text-xs"
                >
                  {quizzing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GraduationCap className="h-4 w-4" />
                  )}
                  出几道题
                </Button>
              )}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
