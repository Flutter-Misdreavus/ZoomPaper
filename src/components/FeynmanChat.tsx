import { useEffect, useMemo, useRef, useState } from "react";
import { Reorder } from "motion/react";
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
    case "teaching":
      return <GraduationCap className="h-3 w-3 text-primary" />;
    default:
      return <Circle className="h-3 w-3 text-muted-foreground/50" />;
  }
}

/**
 * 费曼学习法对话（闯关式教学流）：用户扮演老师讲解论文概念，AI 扮演「聪明但陌生的本科生」。
 * 流程：AI 生成概念计划（可编辑确认）→ 逐概念闯关（讲解 → 追问 → 测验 → 判定）→ 全部完成复盘。
 * 旧会话（无 feynman_state）保持自由聊天模式，不显示闯关 UI。
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
  // 计划编辑草稿（planning 阶段）：可增删、拖动排序、内联编辑
  const [planDraft, setPlanDraft] = useState<PlanDraftItem[]>([]);
  const [newName, setNewName] = useState("");
  const [newObjective, setNewObjective] = useState("");
  // 内联编辑状态：正在编辑的条目 id 与草稿值
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editObjective, setEditObjective] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 恢复该论文最近的费曼会话（含闯关状态）
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
            setError("闯关状态解析失败");
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
  }, [messages, sending, review, starting, judging, quizzing, fs]);

  // 派生状态
  const isPlanning = fs?.status === "planning";
  const isQuiz = fs?.status === "quiz";
  const allDone = fs?.status === "done";
  const currentConcept = fs ? fs.plan[fs.current_index] : undefined;
  const currentCs = fs ? fs.concepts[fs.current_index] : undefined;
  const currentPassed = currentCs?.status === "passed";
  const currentWeak = currentCs?.status === "weak";
  const canQuiz =
    !!convId && fs?.status === "teaching" && !currentPassed && !sending && !quizzing;
  // 测验中是否已有作答（出题消息之后的 user 消息）
  const hasQuizAnswers = useMemo(() => {
    if (fs?.status !== "quiz") return false;
    const lastAssistant = [...messages].map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistant === -1) return false;
    return messages.slice(lastAssistant + 1).some((m) => m.role === "user");
  }, [fs, messages]);
  const canJudge = isQuiz && hasQuizAnswers && !judging && !sending;

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const turn = await feynmanStart(paperId);
      setConvId(turn.conversation_id);
      // 不生成开场白：仅展示概念计划卡片，确认后学生再提问
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
      // 测验作答阶段 reply 为空（由「交卷」统一判定）
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
      // 剥离本地 id，只提交 {name, objective}（后端契约不变）
      const plan: PlanItem[] = planDraft.map(({ id: _id, ...rest }) => rest);
      const turn = await feynmanConfirmPlan(convId, plan);
      // 学生针对第一个概念提出引导问题
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
      // 学生针对新概念提出引导问题
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

  /** 进入内联编辑：记录被编辑条目 id 与当前值 */
  function startEdit(item: PlanDraftItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditObjective(item.objective);
  }

  /** 保存内联编辑：名称非空才允许，更新草稿后退出编辑 */
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
      {/* 顶部：概念 stepper + 操作按钮 */}
      {messages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {fs && !isPlanning && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {fs.current_index + 1}/{fs.plan.length}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5">
                {fs.plan.map((p, i) => {
                  const cs = fs.concepts[i];
                  const isCurrent = i === fs.current_index;
                  return (
                    <div
                      key={i}
                      title={`${i + 1}. ${p.name}`}
                      className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                        isCurrent
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {statusIcon(cs.status)}
                      <span className="max-w-24 truncate">{p.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
        </div>
      )}

      {/* 当前关卡状态条 */}
      {fs && !isPlanning && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
          {allDone ? (
            <span>🎉 全部概念已讲完！可以点击右上角「复盘」检查整体讲解质量。</span>
          ) : currentPassed ? (
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span>
                ✅ 「{currentConcept?.name}」已通过测验 —— 进入下一关，或直接开讲下一概念。
              </span>
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
            </div>
          ) : currentWeak ? (
            <div>
              <span>
                ⚠️ 「{currentConcept?.name}」还需补讲：请针对缺口再讲一遍，然后重新「测验我」。
              </span>
              {currentCs && currentCs.weak_points.length > 0 && (
                <div className="mt-1 line-clamp-2 text-muted-foreground">
                  {currentCs.weak_points[0]}
                </div>
              )}
            </div>
          ) : isQuiz ? (
            <span>
              📝 学生已出题，请作答后点「交卷」；也可以继续补充讲解。
            </span>
          ) : (
            <span>
              🎯 当前关卡 {fs.current_index + 1}/{fs.plan.length}：「{currentConcept?.name}」 ——
              请用你自己的话讲给我听，讲完可以点「测验我」检验。
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
        ) : messages.length === 0 ? (
          fs ? null : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center text-muted-foreground">
              <GraduationCap className="h-10 w-10" />
              <p className="max-w-md text-sm">
                用费曼学习法把这篇论文讲明白：AI 先生成一份概念教学计划，你逐个概念讲解，学生追问并用测验检验你是否真的讲透了。
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
          )
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

      {/* 输入区：测验/交卷按钮 + 发送 */}
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
          placeholder={
            isQuiz
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
