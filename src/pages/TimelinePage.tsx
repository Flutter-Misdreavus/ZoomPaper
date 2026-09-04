import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  createReadingPlan,
  deleteReadingPlan,
  listPapers,
  listReadingPlans,
  timelineStats,
  updateReadingPlan,
  type Paper,
  type ReadingPlan,
  type TimelineDay,
  type TimelineStats,
} from "@/lib/api";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import {
  BookCheck,
  CalendarClock,
  Clock,
  Flame,
  Plus,
  Trash2,
} from "lucide-react";

/** 最近 N 天统计（覆盖热力图 17 周 ≈ 119 天） */
const STATS_DAYS = 120;
/** 热力图周数 */
const HEATMAP_WEEKS = 17;

interface Props {
  onOpenPaper: (paperId: string) => void;
}

/** 本地日期 → 「YYYY-MM-DD」（与后端 localtime 聚合口径一致） */
function dateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 热力图着色档位（按当天阅读时长） */
function heatLevel(seconds: number): number {
  if (seconds <= 0) return 0;
  if (seconds < 900) return 1; // < 15 分钟
  if (seconds < 2700) return 2; // < 45 分钟
  if (seconds < 5400) return 3; // < 90 分钟
  return 4;
}

const HEAT_CLASSES = [
  "bg-zp-surface",
  "bg-emerald-200",
  "bg-emerald-400",
  "bg-emerald-600",
  "bg-emerald-700",
];

export function TimelinePage({ onOpenPaper }: Props) {
  const [stats, setStats] = useState<TimelineStats | null>(null);
  const [plans, setPlans] = useState<ReadingPlan[]>([]);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([timelineStats(STATS_DAYS), listReadingPlans(), listPapers()])
      .then(([s, pl, ps]) => {
        setStats(s);
        setPlans(pl);
        setPapers(ps);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(reload, [reload]);

  const todayStr = dateStr(new Date());
  const dayMap = useMemo(
    () => new Map((stats?.days ?? []).map((d) => [d.date, d])),
    [stats],
  );
  const today = dayMap.get(todayStr);
  const dailyPlan = plans.find((p) => p.active && p.type === "daily");

  // 热力图格子：列 = 周（旧→新），行 = 周日..周六
  const weeks = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - start.getDay() - (HEATMAP_WEEKS - 1) * 7);
    const cols: { date: Date; key: string; future: boolean }[][] = [];
    for (let w = 0; w < HEATMAP_WEEKS; w++) {
      const col: { date: Date; key: string; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        col.push({ date, key: dateStr(date), future: date > end });
      }
      cols.push(col);
    }
    return cols;
  }, []);

  const selectedDay: TimelineDay | null = selectedDate
    ? (dayMap.get(selectedDate) ?? null)
    : null;

  // 阅读历史：按 last_read_at 倒序
  const history = useMemo(
    () =>
      papers
        .filter((p) => p.last_read_at != null)
        .sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0))
        .slice(0, 20),
    [papers],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">时间线</h1>
        <p className="text-sm text-muted-foreground">
          记录每天的阅读时长与论文，追踪阅读计划的完成情况
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 今日概览 */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Clock className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <div>
              <div className="text-lg font-semibold">
                {formatDuration(today?.seconds ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">今日阅读时长</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <BookCheck className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <div>
              <div className="text-lg font-semibold">
                {today?.finished_count ?? 0}
                {dailyPlan?.target_count != null && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {" "}/ {dailyPlan.target_count} 篇
                  </span>
                )}
                {!dailyPlan && <span className="text-sm font-normal text-muted-foreground"> 篇</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                今日读完
                {dailyPlan &&
                  (today != null && today.finished_count >= (dailyPlan.target_count ?? 0) ? (
                    <span className="ml-1 text-emerald-600">已达标</span>
                  ) : (
                    <span className="ml-1 text-destructive">未达标</span>
                  ))}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Flame className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <div>
              <div className="text-lg font-semibold">{stats?.streak ?? 0} 天</div>
              <div className="text-xs text-muted-foreground">连续阅读</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 热力图 + 当日明细 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">阅读热力图</h2>
        <Card>
          <CardContent className="overflow-x-auto p-4">
            <div className="flex gap-[3px]">
              {weeks.map((col, wi) => (
                <div key={wi} className="flex flex-col gap-[3px]">
                  {col.map((cell) => {
                    if (cell.future) {
                      return <div key={cell.key} className="h-3.5 w-3.5" />;
                    }
                    const day = dayMap.get(cell.key);
                    const secs = day?.seconds ?? 0;
                    const isSelected = selectedDate === cell.key;
                    return (
                      <button
                        key={cell.key}
                        type="button"
                        title={`${cell.key} · 阅读 ${formatDuration(secs)} · 读完 ${day?.finished_count ?? 0} 篇`}
                        onClick={() =>
                          setSelectedDate(isSelected ? null : cell.key)
                        }
                        className={cn(
                          "h-3.5 w-3.5 rounded-[3px] transition-transform hover:scale-125",
                          HEAT_CLASSES[heatLevel(secs)],
                          isSelected && "ring-2 ring-zp-primary",
                        )}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>少</span>
              {HEAT_CLASSES.map((c, i) => (
                <span key={i} className={cn("h-3 w-3 rounded-[3px]", c)} />
              ))}
              <span>多</span>
              <span className="ml-2">按当天阅读时长着色，点击格子查看当日明细</span>
            </div>
          </CardContent>
        </Card>

        {selectedDate && (
          <Card>
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-baseline gap-3">
                <span className="font-semibold">{selectedDate}</span>
                <span className="text-sm text-muted-foreground">
                  阅读 {formatDuration(selectedDay?.seconds ?? 0)} · 读过{" "}
                  {selectedDay?.paper_count ?? 0} 篇 · 读完{" "}
                  {selectedDay?.finished_count ?? 0} 篇
                </span>
              </div>
              {selectedDay && selectedDay.papers.length > 0 ? (
                <ul className="flex flex-col">
                  {selectedDay.papers.map((p) => (
                    <li key={p.paper_id}>
                      <button
                        type="button"
                        onClick={() => onOpenPaper(p.paper_id)}
                        className="pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zp-surface-hover"
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            p.reading_status === "read"
                              ? "bg-emerald-500"
                              : p.reading_status === "reading"
                                ? "bg-amber-500"
                                : "bg-zp-quaternary",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{p.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatDuration(p.seconds)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">这一天没有阅读记录</p>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {/* 阅读计划 */}
      <PlansSection
        plans={plans}
        papers={papers}
        todayFinished={today?.finished_count ?? 0}
        onChanged={reload}
        onOpenPaper={onOpenPaper}
      />

      {/* 阅读历史 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">阅读历史</h2>
        {history.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            还没有阅读记录，去读一篇论文吧
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col p-2">
              {history.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenPaper(p.id)}
                  className="pressable flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-zp-surface-hover"
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      p.reading_status === "read"
                        ? "bg-emerald-500"
                        : p.reading_status === "reading"
                          ? "bg-amber-500"
                          : "bg-zp-quaternary",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    累计 {formatDuration(p.total_read_seconds)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {p.last_read_at != null && formatTime(p.last_read_at)}
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

// ---------- 阅读计划区块 ----------

interface PlansProps {
  plans: ReadingPlan[];
  papers: Paper[];
  todayFinished: number;
  onChanged: () => void;
  onOpenPaper: (paperId: string) => void;
}

function PlansSection({ plans, papers, todayFinished, onChanged, onOpenPaper }: PlansProps) {
  const [showForm, setShowForm] = useState(false);
  const [deleting, setDeleting] = useState<ReadingPlan | null>(null);
  const paperMap = useMemo(() => new Map(papers.map((p) => [p.id, p])), [papers]);

  const confirmDelete = () => {
    if (!deleting) return;
    deleteReadingPlan(deleting.id)
      .then(onChanged)
      .catch(() => {})
      .finally(() => setDeleting(null));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">阅读计划</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowForm((v) => !v)}
          className="pressable"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} />
          新建计划
        </Button>
      </div>

      {showForm && (
        <PlanForm
          papers={papers}
          onCreated={() => {
            setShowForm(false);
            onChanged();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {plans.length === 0 && !showForm ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          还没有阅读计划，定一个目标监督自己吧
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              paperMap={paperMap}
              todayFinished={todayFinished}
              onChanged={onChanged}
              onDelete={() => setDeleting(plan)}
              onOpenPaper={onOpenPaper}
            />
          ))}
        </div>
      )}

      <AlertDialog open={deleting != null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除阅读计划</AlertDialogTitle>
            <AlertDialogDescription>
              将删除该计划，论文本身与阅读记录不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function PlanCard({
  plan,
  paperMap,
  todayFinished,
  onChanged,
  onDelete,
  onOpenPaper,
}: {
  plan: ReadingPlan;
  paperMap: Map<string, Paper>;
  todayFinished: number;
  onChanged: () => void;
  onDelete: () => void;
  onOpenPaper: (paperId: string) => void;
}) {
  const toggleActive = () => {
    updateReadingPlan(plan.id, { active: !plan.active })
      .then(onChanged)
      .catch(() => {});
  };

  if (plan.type === "daily") {
    const target = plan.target_count ?? 1;
    const done = todayFinished >= target;
    return (
      <Card>
        <CardContent className="flex items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">每天读完 {target} 篇</span>
              {!plan.active && <Badge variant="secondary">已停用</Badge>}
              {plan.active &&
                (done ? (
                  <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                    今日已达标
                  </Badge>
                ) : (
                  <Badge variant="destructive">今日未达标</Badge>
                ))}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zp-surface">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  done ? "bg-emerald-500" : "bg-zp-primary",
                )}
                style={{ width: `${Math.min(100, (todayFinished / target) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              今日进度 {todayFinished} / {target} 篇
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={toggleActive} className="pressable shrink-0">
            {plan.active ? "停用" : "启用"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            className="pressable shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.8} />
          </Button>
        </CardContent>
      </Card>
    );
  }

  // papers 计划：指派论文 + 截止日期
  const total = plan.paper_ids.length;
  const doneCount = plan.paper_ids.filter(
    (id) => paperMap.get(id)?.reading_status === "read",
  ).length;
  const allDone = total > 0 && doneCount >= total;
  const now = Date.now() / 1000;
  const overdue = plan.deadline != null && !allDone && plan.deadline < now;
  const daysLeft =
    plan.deadline != null ? Math.ceil((plan.deadline - now) / 86400) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <span className="font-medium">
            读完 {total} 篇论文（已完成 {doneCount} / {total}）
          </span>
          {allDone ? (
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">已完成</Badge>
          ) : overdue ? (
            <Badge variant="destructive">
              <CalendarClock className="mr-1 h-3 w-3" />
              已逾期
            </Badge>
          ) : daysLeft != null && daysLeft <= 3 ? (
            <Badge className="bg-amber-500 text-white hover:bg-amber-500">
              <CalendarClock className="mr-1 h-3 w-3" />
              还剩 {daysLeft} 天
            </Badge>
          ) : plan.deadline != null ? (
            <Badge variant="secondary">
              截止 {formatTime(plan.deadline)}
            </Badge>
          ) : null}
          {!plan.active && <Badge variant="secondary">已停用</Badge>}
          <div className="ml-auto flex shrink-0 items-center">
            {!allDone && (
              <Button variant="ghost" size="sm" onClick={toggleActive} className="pressable">
                {plan.active ? "停用" : "启用"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              className="pressable text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.8} />
            </Button>
          </div>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zp-surface">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              allDone ? "bg-emerald-500" : "bg-zp-primary",
            )}
            style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
          />
        </div>
        <ul className="flex flex-col">
          {plan.paper_ids.map((id) => {
            const p = paperMap.get(id);
            const read = p?.reading_status === "read";
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onOpenPaper(id)}
                  className="pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zp-surface-hover"
                >
                  <BookCheck
                    className={cn(
                      "h-4 w-4 shrink-0",
                      read ? "text-emerald-500" : "text-zp-quaternary",
                    )}
                    strokeWidth={1.8}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      read && "text-muted-foreground line-through",
                    )}
                  >
                    {p?.title ?? "（论文已删除）"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** 新建计划表单（inline）：daily = 目标篇数；papers = 选论文 + 截止日期 */
function PlanForm({
  papers,
  onCreated,
  onCancel,
}: {
  papers: Paper[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<"daily" | "papers">("daily");
  const [target, setTarget] = useState("2");
  const [deadline, setDeadline] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const togglePaper = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    setError(null);
    setSubmitting(true);
    const deadlineTs = deadline
      ? Math.floor(new Date(`${deadline}T23:59:59`).getTime() / 1000)
      : undefined;
    createReadingPlan(type, {
      targetCount: type === "daily" ? parseInt(target, 10) || 0 : undefined,
      paperIds: type === "papers" ? [...selected] : undefined,
      deadline: type === "papers" ? deadlineTs : undefined,
    })
      .then(onCreated)
      .catch((e) => setError(String(e)))
      .finally(() => setSubmitting(false));
  };

  const candidates = papers.filter((p) => p.reading_status !== "read");

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>计划类型</Label>
            <Select
              value={type}
              onValueChange={(v) => setType((v as "daily" | "papers") ?? "daily")}
              items={[
                { value: "daily", label: "每日定量目标" },
                { value: "papers", label: "指派论文清单" },
              ]}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">每日定量目标</SelectItem>
                <SelectItem value="papers">指派论文清单</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {type === "daily" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-target">每天读完（篇）</Label>
              <Input
                id="plan-target"
                type="number"
                min={1}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-28"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-deadline">截止日期（可选）</Label>
              <Input
                id="plan-deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-44"
              />
            </div>
          )}
        </div>

        {type === "papers" && (
          <div className="flex flex-col gap-1.5">
            <Label>选择论文（已选 {selected.size} 篇）</Label>
            <div className="max-h-48 overflow-y-auto rounded-md border border-zp-border">
              {candidates.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  没有可指派的论文（均已读完）
                </p>
              ) : (
                candidates.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-zp-surface-hover"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => togglePaper(p.id)}
                      className="accent-zp-primary"
                    />
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {p.reading_status === "reading" ? "在读" : "未读"}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="pressable">
            取消
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={submitting}
            className="pressable"
          >
            {submitting ? "创建中…" : "创建计划"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
