import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/MarkdownView";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  quizDelete,
  quizGenerate,
  quizGet,
  quizGradeAll,
  quizList,
  quizSections,
  quizSubmitAnswer,
  type QuestionGrade,
  type Quiz,
  type QuizQuestion,
  type QuizSummary,
} from "@/lib/api";
import { formatTime } from "@/lib/utils";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";

interface Props {
  paperId: string;
}

/** 面板四个视图：历史列表（默认）/ 出题配置 / 作答 / 结果 */
type View = "history" | "config" | "answering" | "result";

type QuizMode = "exam" | "practice";

const DIFFICULTIES = ["基础", "进阶", "挑战"];
const FOCUSES = ["全面", "方法", "实验", "结论"];
/** 选择题选项字母（后端 options 不含前缀，渲染时自行添加） */
const LETTERS = "ABCDEFGHIJ";
const MAX_CHOICE = 10;
const MAX_SUBJECTIVE = 5;
/** 章节列表超过该数量时折叠为可滚动区域 */
const SECTION_SCROLL_THRESHOLD = 6;

/**
 * 论文阅读理解测验面板（窄栏 280-560px，垂直滚动，一题一卡片）。
 *
 * 四个视图状态与数据流：
 * 1. history（默认）：quizList 加载历史；「继续作答」quizGet 恢复进入作答视图，
 *    已完成则进结果视图；hover 出现删除按钮（AlertDialog 二次确认）。
 * 2. config：模式/题数/难度/侧重点/章节范围配置，「开始出题」调 quizGenerate
 *    （耗时十几秒，按钮禁用 + loading 文案），成功后进入作答视图。
 * 3. answering：作答进度（答案与批改）全在本地 state 维护——
 *    练习模式逐题展示，提交 quizSubmitAnswer 后在卡片下方即时展示批改；
 *    考试模式整卷列出，底部固定「交卷」（确认弹窗提示未答数），
 *    quizGradeAll 批改中显示全屏 loading。中途退出后从 history 恢复时
 *    用 quiz.answers / quiz.grading 回填，练习模式跳到第一道未答题。
 * 4. result：总分（百分制）+ 每题批改卡片 + 考试模式的总评报告（MarkdownView）。
 *
 * 所有视图共享一个 error 红色提示条；busy 派生自各异步态，防并发操作。
 */
export function QuizPanel({ paperId }: Props) {
  const [view, setView] = useState<View>("history");
  /** 共享错误条（视图切换时清除） */
  const [error, setError] = useState<string | null>(null);

  // ---- 历史列表 ----
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  /** 正在打开的测验 id（历史条目点击后 loading） */
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<QuizSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ---- 出题配置 ----
  const [mode, setMode] = useState<QuizMode>("practice");
  const [choiceCount, setChoiceCount] = useState(3);
  const [subjectiveCount, setSubjectiveCount] = useState(2);
  const [difficulty, setDifficulty] = useState(DIFFICULTIES[0]);
  const [focus, setFocus] = useState(FOCUSES[0]);
  const [sections, setSections] = useState<string[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  /** 选中的出题章节；空 = 全文 */
  const [selectedSections, setSelectedSections] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);

  // ---- 作答 / 结果（当前激活的完整测验） ----
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  /** 题号 → 用户作答（练习=字母/文本；考试=整卷草稿；恢复时由 quiz.answers 回填） */
  const [answersMap, setAnswersMap] = useState<Record<number, string>>({});
  /** 题号 → 批改结果（练习即时批改 + 恢复时由 quiz.grading 回填） */
  const [grades, setGrades] = useState<Record<number, QuestionGrade>>({});
  /** 练习模式当前题索引 */
  const [practiceIdx, setPracticeIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [gradingAll, setGradingAll] = useState(false);
  const [submitExamOpen, setSubmitExamOpen] = useState(false);

  const busy = generating || submitting || gradingAll || deleting || openingId != null;

  // ---- 数据加载 ----

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      setQuizzes(await quizList(paperId));
    } catch (e) {
      setError(String(e));
    } finally {
      setListLoading(false);
    }
  }, [paperId]);

  // 论文切换：回到历史视图并重载（面板常驻挂载，需显式重置）
  useEffect(() => {
    setView("history");
    setQuiz(null);
    setError(null);
    setAnswersMap({});
    setGrades({});
    setSelectedSections([]);
    void loadList();
  }, [loadList]);

  function gotoView(v: View) {
    setError(null);
    setView(v);
  }

  /** 进入配置视图时加载章节列表（出题范围多选数据源） */
  async function openConfig() {
    gotoView("config");
    setSectionsLoading(true);
    try {
      setSections(await quizSections(paperId));
    } catch (e) {
      setError(String(e));
    } finally {
      setSectionsLoading(false);
    }
  }

  /** 返回历史并刷新（作答/删除后状态可能变化） */
  function backToHistory() {
    gotoView("history");
    void loadList();
  }

  /** 用一份完整测验初始化作答态（新建 / 恢复共用） */
  function enterAnswering(q: Quiz) {
    setQuiz(q);
    const am: Record<number, string> = {};
    for (const a of q.answers) am[a.question_id] = a.answer;
    setAnswersMap(am);
    const gm: Record<number, QuestionGrade> = {};
    for (const g of q.grading) gm[g.question_id] = g;
    setGrades(gm);
    // 练习模式：跳到第一道未答题；全部已答则停在最后一题
    const firstTodo = q.questions.findIndex((qq) => !(qq.id in am));
    setPracticeIdx(firstTodo === -1 ? Math.max(0, q.questions.length - 1) : firstTodo);
    gotoView("answering");
  }

  /** 历史条目点击：未完成 → 恢复作答；已完成 → 结果视图 */
  async function openQuiz(s: QuizSummary) {
    setOpeningId(s.id);
    setError(null);
    try {
      const q = await quizGet(s.id);
      if (s.status === "done") {
        setQuiz(q);
        const am: Record<number, string> = {};
        for (const a of q.answers) am[a.question_id] = a.answer;
        setAnswersMap(am);
        gotoView("result");
      } else {
        enterAnswering(q);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setOpeningId(null);
    }
  }

  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await quizDelete(confirmDelete.id);
      setConfirmDelete(null);
      void loadList();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  // ---- 出题 ----

  async function handleGenerate() {
    if (choiceCount + subjectiveCount < 1) return;
    setGenerating(true);
    setError(null);
    try {
      const q = await quizGenerate(paperId, mode, {
        choice_count: choiceCount,
        subjective_count: subjectiveCount,
        difficulty,
        focus,
        sections: selectedSections,
      });
      enterAnswering(q);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  // ---- 练习模式：逐题提交 ----

  async function handlePracticeSubmit() {
    if (!quiz) return;
    const q = quiz.questions[practiceIdx];
    const ans = (answersMap[q.id] ?? "").trim();
    if (!ans) return;
    setSubmitting(true);
    setError(null);
    try {
      const g = await quizSubmitAnswer(quiz.id, q.id, ans);
      setGrades((prev) => ({ ...prev, [q.id]: g }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 最后一题批改完 → 拉取完整测验（含总分）进结果视图 */
  async function showResult() {
    if (!quiz) return;
    setSubmitting(true);
    setError(null);
    try {
      const full = await quizGet(quiz.id);
      setQuiz(full);
      const am: Record<number, string> = {};
      for (const a of full.answers) am[a.question_id] = a.answer;
      setAnswersMap((prev) => ({ ...prev, ...am }));
      gotoView("result");
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // ---- 考试模式：整卷交卷 ----

  async function handleGradeAll() {
    if (!quiz) return;
    setSubmitExamOpen(false);
    setGradingAll(true);
    setError(null);
    try {
      // 未作答题目以空串提交，保证整卷都有批改结果
      const answers = quiz.questions.map((q) => ({
        question_id: q.id,
        answer: answersMap[q.id] ?? "",
      }));
      const full = await quizGradeAll(quiz.id, answers);
      setQuiz(full);
      const gm: Record<number, QuestionGrade> = {};
      for (const g of full.grading) gm[g.question_id] = g;
      setGrades(gm);
      gotoView("result");
    } catch (e) {
      setError(String(e));
    } finally {
      setGradingAll(false);
    }
  }

  // ---- 渲染 ----

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 非历史视图的顶部导航 */}
      {view !== "history" && (
        <div className="flex items-center gap-1.5 pb-2">
          <button
            onClick={backToHistory}
            disabled={busy}
            title="返回历史"
            className="pressable rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium text-muted-foreground">
            {view === "config" && "新建测验"}
            {view === "answering" && "作答中"}
            {view === "result" && "测验结果"}
          </span>
          {quiz && view !== "config" && <ModeBadge mode={quiz.mode} />}
          {view === "answering" && quiz && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              已答 {Object.keys(answersMap).length}/{quiz.questions.length}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {view === "history" && (
        <HistoryView
          quizzes={quizzes}
          loading={listLoading}
          openingId={openingId}
          busy={busy}
          onNew={() => void openConfig()}
          onOpen={(s) => void openQuiz(s)}
          onDelete={setConfirmDelete}
        />
      )}

      {view === "config" && (
        <ConfigView
          mode={mode}
          setMode={setMode}
          choiceCount={choiceCount}
          setChoiceCount={setChoiceCount}
          subjectiveCount={subjectiveCount}
          setSubjectiveCount={setSubjectiveCount}
          difficulty={difficulty}
          setDifficulty={setDifficulty}
          focus={focus}
          setFocus={setFocus}
          sections={sections}
          sectionsLoading={sectionsLoading}
          selectedSections={selectedSections}
          setSelectedSections={setSelectedSections}
          generating={generating}
          onGenerate={() => void handleGenerate()}
        />
      )}

      {view === "answering" && quiz && (
        <AnsweringView
          quiz={quiz}
          answersMap={answersMap}
          setAnswer={(qid, v) => setAnswersMap((prev) => ({ ...prev, [qid]: v }))}
          grades={grades}
          practiceIdx={practiceIdx}
          setPracticeIdx={setPracticeIdx}
          submitting={submitting}
          onPracticeSubmit={() => void handlePracticeSubmit()}
          onShowResult={() => void showResult()}
          onSubmitExam={() => setSubmitExamOpen(true)}
        />
      )}

      {view === "result" && quiz && (
        <ResultView
          quiz={quiz}
          answersMap={answersMap}
          onBack={backToHistory}
          onAgain={() => void openConfig()}
        />
      )}

      {/* 考试模式批改中：全屏 loading 遮罩 */}
      {gradingAll && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-card/90">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-[13px] text-muted-foreground">AI 正在批改…</p>
        </div>
      )}

      {/* 删除测验确认 */}
      <AlertDialog
        open={confirmDelete != null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除测验</AlertDialogTitle>
            <AlertDialogDescription>
              将删除这份{confirmDelete?.mode === "exam" ? "考试" : "练习"}
              测验及其作答与批改记录，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={() => void handleDeleteConfirm()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 考试交卷确认（提示未作答题目数） */}
      <AlertDialog open={submitExamOpen} onOpenChange={setSubmitExamOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认交卷</AlertDialogTitle>
            <AlertDialogDescription>
              {quiz
                ? (() => {
                    const todo = quiz.questions.filter(
                      (q) => !(answersMap[q.id] ?? "").trim(),
                    ).length;
                    return todo > 0
                      ? `还有 ${todo} 道题未作答，未作答题目将按 0 分计。交卷后不可修改。`
                      : "全部题目已作答。交卷后不可修改。";
                  })()
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再检查一下</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleGradeAll()}>
              交卷
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 模式小徽标 */
function ModeBadge({ mode }: { mode: string }) {
  return (
    <Badge variant={mode === "exam" ? "default" : "secondary"}>
      {mode === "exam" ? "考试" : "练习"}
    </Badge>
  );
}

/** 分段单选行（难度/侧重点等少量选项） */
function SegRow({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o}
          disabled={disabled}
          onClick={() => onChange(o)}
          className={`pressable rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            value === o
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** 题数步进器（- 数值 +） */
function Stepper({
  value,
  max,
  onChange,
  disabled,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const btn =
    "pressable flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <button
        className={btn}
        disabled={disabled || value <= 0}
        onClick={() => onChange(value - 1)}
        title="减少"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-5 text-center text-[13px] font-medium tabular-nums">{value}</span>
      <button
        className={btn}
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        title="增加"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 历史/入口视图 */
function HistoryView({
  quizzes,
  loading,
  openingId,
  busy,
  onNew,
  onOpen,
  onDelete,
}: {
  quizzes: QuizSummary[];
  loading: boolean;
  openingId: string | null;
  busy: boolean;
  onNew: () => void;
  onOpen: (s: QuizSummary) => void;
  onDelete: (s: QuizSummary) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Button onClick={onNew} disabled={busy} className="pressable w-full gap-1.5">
        <Plus className="h-4 w-4" />
        新建测验
      </Button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : quizzes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ClipboardList className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-[13px] text-muted-foreground">还没有测验记录</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 py-0.5">
            {quizzes.map((s) => (
              <div key={s.id} className="group relative">
                <button
                  onClick={() => onOpen(s)}
                  disabled={busy}
                  className="block w-full rounded-md border border-border px-2.5 py-2 text-left transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="flex items-center gap-1.5 pr-6">
                    <ModeBadge mode={s.mode} />
                    <span className="text-xs text-muted-foreground">
                      {s.difficulty} · {s.focus}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {s.question_count} 题
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    {s.status === "done" ? (
                      s.score != null && (
                        <span className="font-medium text-foreground">{s.score} 分</span>
                      )
                    ) : (
                      <span className="font-medium text-primary">
                        {openingId === s.id ? "恢复中…" : "继续作答"}
                      </span>
                    )}
                    <span className="ml-auto">{formatTime(s.updated_at)}</span>
                  </div>
                </button>
                <button
                  onClick={() => onDelete(s)}
                  title="删除测验"
                  className="pressable absolute top-2 right-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 出题配置视图 */
function ConfigView({
  mode,
  setMode,
  choiceCount,
  setChoiceCount,
  subjectiveCount,
  setSubjectiveCount,
  difficulty,
  setDifficulty,
  focus,
  setFocus,
  sections,
  sectionsLoading,
  selectedSections,
  setSelectedSections,
  generating,
  onGenerate,
}: {
  mode: QuizMode;
  setMode: (m: QuizMode) => void;
  choiceCount: number;
  setChoiceCount: (n: number) => void;
  subjectiveCount: number;
  setSubjectiveCount: (n: number) => void;
  difficulty: string;
  setDifficulty: (s: string) => void;
  focus: string;
  setFocus: (s: string) => void;
  sections: string[];
  sectionsLoading: boolean;
  selectedSections: string[];
  setSelectedSections: (fn: (prev: string[]) => string[]) => void;
  generating: boolean;
  onGenerate: () => void;
}) {
  const total = choiceCount + subjectiveCount;

  function toggleSection(name: string) {
    setSelectedSections((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name],
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-0.5 pb-2">
        {/* 答题模式 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">答题模式</div>
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { v: "exam" as QuizMode, label: "考试模式", desc: "整卷作答，统一交卷批改 + 总评" },
                { v: "practice" as QuizMode, label: "练习模式", desc: "逐题作答，即时反馈" },
              ]
            ).map((m) => (
              <button
                key={m.v}
                disabled={generating}
                onClick={() => setMode(m.v)}
                className={`rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                  mode === m.v
                    ? "border-primary/60 bg-primary/10"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <div className="text-[13px] font-medium">{m.label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {m.desc}
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* 题量 */}
        <section className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">题量</div>
          <div className="flex items-center justify-between">
            <span className="text-[13px]">选择题</span>
            <Stepper
              value={choiceCount}
              max={MAX_CHOICE}
              onChange={setChoiceCount}
              disabled={generating}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px]">主观题</span>
            <Stepper
              value={subjectiveCount}
              max={MAX_SUBJECTIVE}
              onChange={setSubjectiveCount}
              disabled={generating}
            />
          </div>
          {total < 1 && (
            <p className="text-[11px] text-destructive">选择题与主观题合计至少 1 题</p>
          )}
        </section>

        {/* 难度 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">难度</div>
          <SegRow
            options={DIFFICULTIES}
            value={difficulty}
            onChange={setDifficulty}
            disabled={generating}
          />
        </section>

        {/* 侧重点 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">侧重点</div>
          <SegRow
            options={FOCUSES}
            value={focus}
            onChange={setFocus}
            disabled={generating}
          />
        </section>

        {/* 出题范围 */}
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">出题范围</div>
            {selectedSections.length > 0 && (
              <button
                onClick={() => setSelectedSections(() => [])}
                disabled={generating}
                className="pressable text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                清空（回到全文）
              </button>
            )}
          </div>
          {sectionsLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : sections.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">未识别到章节，默认按全文出题</p>
          ) : (
            <>
              <div
                className={`flex flex-col gap-0.5 rounded-md border border-border p-1.5 ${
                  sections.length > SECTION_SCROLL_THRESHOLD
                    ? "max-h-36 overflow-y-auto"
                    : ""
                }`}
              >
                {sections.map((name) => (
                  <label
                    key={name}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] transition-colors hover:bg-accent/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSections.includes(name)}
                      onChange={() => toggleSection(name)}
                      disabled={generating}
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 truncate">{name}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {selectedSections.length > 0
                  ? `已选 ${selectedSections.length} 个章节`
                  : "空选 = 全文（默认）"}
              </p>
            </>
          )}
        </section>
      </div>

      {/* 底部操作 */}
      <div className="flex flex-col gap-1.5 border-t pt-2">
        <Button
          onClick={onGenerate}
          disabled={generating || total < 1}
          className="pressable w-full gap-1.5"
        >
          {generating && <Loader2 className="h-4 w-4 animate-spin" />}
          {generating ? "正在出题…" : "开始出题"}
        </Button>
        {generating && (
          <p className="text-center text-[11px] text-muted-foreground">
            AI 正在阅读论文并出题…
          </p>
        )}
      </div>
    </div>
  );
}

/** 选择题选项列表（作答点选 / 批改后揭示对错） */
function ChoiceList({
  q,
  value,
  onChange,
  locked,
  reveal,
}: {
  q: QuizQuestion;
  value: string;
  onChange?: (letter: string) => void;
  locked?: boolean;
  /** 是否揭示答案（练习提交后 / 结果视图） */
  reveal?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {(q.options ?? []).map((opt, i) => {
        const letter = LETTERS[i];
        const selected = value === letter;
        let cls = "border-border text-foreground/85 hover:bg-accent/50";
        if (reveal) {
          if (letter === q.answer) {
            cls = "border-emerald-500/50 bg-emerald-500/10 text-foreground";
          } else if (selected) {
            cls = "border-destructive/50 bg-destructive/10 text-foreground";
          } else {
            cls = "border-border text-muted-foreground";
          }
        } else if (selected) {
          cls = "border-primary/60 bg-primary/10 text-foreground";
        }
        return (
          <button
            key={i}
            disabled={locked || reveal}
            onClick={() => onChange?.(letter)}
            className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-left text-[13px] transition-colors disabled:cursor-default ${cls}`}
          >
            <span className="shrink-0 font-medium">{letter}.</span>
            <span className="min-w-0">{opt}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 批改结果块（练习即时反馈 / 结果视图共用） */
function GradeDetail({
  q,
  grade,
  userAnswer,
}: {
  q: QuizQuestion;
  grade: QuestionGrade;
  userAnswer?: string;
}) {
  const [showRef, setShowRef] = useState(false);
  const isChoice = q.qtype === "choice";
  const correct = grade.correct === true;
  const gaps = grade.gaps ?? [];

  return (
    <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2 text-[13px]">
      {userAnswer != null && (
        <p className="text-xs text-muted-foreground">
          你的作答：<span className="text-foreground">{userAnswer || "（未作答）"}</span>
        </p>
      )}
      <div className="flex items-center gap-1.5">
        {isChoice ? (
          correct ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                回答正确
              </span>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-xs font-medium text-destructive">回答错误</span>
            </>
          )
        ) : (
          <span className="text-xs font-medium">
            得分 {grade.score}/{grade.max_score}
          </span>
        )}
      </div>
      {isChoice && !correct && (
        <p className="text-xs">
          正确答案：<span className="font-medium">{q.answer}</span>
        </p>
      )}
      {grade.feedback && (
        <p className="text-xs leading-relaxed text-muted-foreground">{grade.feedback}</p>
      )}
      {isChoice && !correct && !grade.feedback && q.explanation && (
        <p className="text-xs leading-relaxed text-muted-foreground">{q.explanation}</p>
      )}
      {gaps.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">薄弱点：</span>
          {gaps.map((g) => (
            <Badge key={g} variant="outline" className="text-[11px] font-normal">
              {g}
            </Badge>
          ))}
        </div>
      )}
      {!isChoice && q.answer && (
        <div>
          <button
            onClick={() => setShowRef((v) => !v)}
            className="pressable flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {showRef ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            参考答案
          </button>
          {showRef && (
            <p className="mt-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
              {q.answer}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 作答视图（练习 = 逐题；考试 = 整卷） */
function AnsweringView({
  quiz,
  answersMap,
  setAnswer,
  grades,
  practiceIdx,
  setPracticeIdx,
  submitting,
  onPracticeSubmit,
  onShowResult,
  onSubmitExam,
}: {
  quiz: Quiz;
  answersMap: Record<number, string>;
  setAnswer: (qid: number, v: string) => void;
  grades: Record<number, QuestionGrade>;
  practiceIdx: number;
  setPracticeIdx: (n: number) => void;
  submitting: boolean;
  onPracticeSubmit: () => void;
  onShowResult: () => void;
  onSubmitExam: () => void;
}) {
  const isPractice = quiz.mode === "practice";

  if (isPractice) {
    const q = quiz.questions[practiceIdx];
    if (!q) return null;
    const grade = grades[q.id];
    const isLast = practiceIdx === quiz.questions.length - 1;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
          <QuestionCard
            q={q}
            index={practiceIdx}
            value={answersMap[q.id] ?? ""}
            onChange={(v) => setAnswer(q.id, v)}
            locked={submitting || grade != null}
            reveal={grade != null}
          />
          {grade && (
            <div className="mt-2 rounded-md border border-border bg-card px-2.5 py-2">
              <GradeDetail q={q} grade={grade} />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 border-t pt-2">
          {!grade ? (
            <Button
              onClick={onPracticeSubmit}
              disabled={submitting || !(answersMap[q.id] ?? "").trim()}
              className="pressable w-full gap-1.5"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "批改中…" : "提交"}
            </Button>
          ) : isLast ? (
            <Button
              onClick={onShowResult}
              disabled={submitting}
              className="pressable w-full gap-1.5"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              查看结果
            </Button>
          ) : (
            <Button
              onClick={() => setPracticeIdx(practiceIdx + 1)}
              className="pressable w-full"
            >
              下一题
            </Button>
          )}
        </div>
      </div>
    );
  }

  // 考试模式：整卷列出 + 底部固定交卷
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
        {quiz.questions.map((q, i) => (
          <QuestionCard
            key={q.id}
            q={q}
            index={i}
            value={answersMap[q.id] ?? ""}
            onChange={(v) => setAnswer(q.id, v)}
          />
        ))}
      </div>
      <div className="border-t pt-2">
        <Button onClick={onSubmitExam} className="pressable w-full">
          交卷
        </Button>
      </div>
    </div>
  );
}

/** 单题卡片：题号 + 题型/章节 + 题干 + 选项/textarea */
function QuestionCard({
  q,
  index,
  value,
  onChange,
  locked,
  reveal,
  bare,
}: {
  q: QuizQuestion;
  index: number;
  value: string;
  onChange: (v: string) => void;
  locked?: boolean;
  reveal?: boolean;
  /** 去掉卡片边框（嵌套在结果卡片内部时使用） */
  bare?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-2 ${
        bare ? "" : "rounded-md border border-border bg-card px-2.5 py-2"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">第 {index + 1} 题</span>
        <Badge variant="secondary" className="text-[11px] font-normal">
          {q.qtype === "choice" ? "选择题" : "主观题"}
        </Badge>
        {q.section && <span className="ml-auto truncate">{q.section}</span>}
      </div>
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{q.question}</p>
      {q.qtype === "choice" ? (
        <ChoiceList
          q={q}
          value={value}
          onChange={onChange}
          locked={locked}
          reveal={reveal}
        />
      ) : (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={locked}
          placeholder="写下你的答案…"
          className="min-h-20 text-[13px]"
        />
      )}
    </div>
  );
}

/** 结果视图：总分 + 每题批改卡片 + 总评报告 */
function ResultView({
  quiz,
  answersMap,
  onBack,
  onAgain,
}: {
  quiz: Quiz;
  answersMap: Record<number, string>;
  onBack: () => void;
  onAgain: () => void;
}) {
  const gradeOf = (qid: number) => quiz.grading.find((g) => g.question_id === qid);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
        {quiz.score != null && (
          <div className="flex flex-col items-center gap-0.5 rounded-md border border-border bg-card py-3">
            <span className="text-3xl font-semibold tabular-nums">
              {Math.round(quiz.score)}
            </span>
            <span className="text-xs text-muted-foreground">总分（百分制）</span>
          </div>
        )}
        {quiz.questions.map((q, i) => {
          const grade = gradeOf(q.id);
          return (
            <div
              key={q.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-card px-2.5 py-2"
            >
              <QuestionCard
                q={q}
                index={i}
                value={answersMap[q.id] ?? ""}
                onChange={() => {}}
                locked
                reveal={q.qtype === "choice"}
                bare
              />
              {grade && (
                <GradeDetail q={q} grade={grade} userAnswer={answersMap[q.id] ?? ""} />
              )}
            </div>
          );
        })}
        {quiz.mode === "exam" && quiz.report && (
          <div className="rounded-md border border-border bg-card px-3 py-2.5">
            <h3 className="mb-1.5 text-[13px] font-medium">总评报告</h3>
            <MarkdownView markdown={quiz.report} className="text-[13px]" />
          </div>
        )}
      </div>
      <div className="flex gap-2 border-t pt-2">
        <Button variant="outline" onClick={onBack} className="pressable flex-1">
          返回历史
        </Button>
        <Button onClick={onAgain} className="pressable flex-1 gap-1.5">
          <RotateCcw className="h-4 w-4" />
          再来一套
        </Button>
      </div>
    </div>
  );
}
