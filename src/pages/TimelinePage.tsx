import { usePreferences, paperTitle } from "@/lib/preferences";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
  removePaperFromPlan,
  timelineStats,
  updateReadingPlan,
  type Paper,
  type ReadingStatus,
  type ReadingPlan,
  type TimelineDay,
  type TimelineStats,
} from "@/lib/api";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { dueBadge } from "@/components/library/planMenu";
import { VenueBadge } from "@/components/library/VenueBadge";
import {
  BookCheck,
  ChevronDown, Pause, Play,
  Clock,
  Flame,
  Plus,
  Trash2,
  X,
} from "lucide-react";

/** GitHub 式全年阅读热力图。 */
const HEATMAP_WEEKS = 52;
const STATS_DAYS = HEATMAP_WEEKS * 7 + 7;

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
  "bg-[#ebedf0] dark:bg-[#2d333b]",
  "bg-[#9be9a8] dark:bg-[#0e4429]",
  "bg-[#40c463] dark:bg-[#006d32]",
  "bg-[#30a14e] dark:bg-[#26a641]",
  "bg-[#216e39] dark:bg-[#39d353]",
];

function readingTitleClass(status: string): string {
  return status === "unread"
    ? "font-semibold text-zp-primary"
    : status === "read"
      ? "font-normal text-zp-tertiary"
      : "font-medium text-zp-primary";
}

export function TimelinePage({ onOpenPaper }: Props) {
  const prefs=usePreferences();
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
        setPapers(ps.filter((paper) => paper.deleted_at == null));
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
  const paperById = useMemo(() => new Map(papers.map((paper) => [paper.id, paper])), [papers]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto pb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">时间线</h1>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 今日概览：用一行数字替代厚重卡片。 */}
      <div className="flex flex-wrap items-center gap-x-10 gap-y-4 border-y border-zp-border py-4">
        <div className="flex items-center gap-3"><Clock className="h-4 w-4 text-zp-quaternary" /><div><div className="text-lg font-semibold">{formatDuration(today?.seconds ?? 0)}</div><div className="text-xs text-zp-quaternary">今日阅读</div></div></div>
        <div className="flex items-center gap-3"><BookCheck className="h-4 w-4 text-zp-quaternary" /><div><div className="text-lg font-semibold">{today?.finished_count ?? 0}<span className="ml-1 text-sm font-normal text-zp-quaternary">{dailyPlan?.target_count != null ? `/ ${dailyPlan.target_count}` : "篇"}</span></div><div className="text-xs text-zp-quaternary">今日读完</div></div></div>
        <div className="flex items-center gap-3"><Flame className="h-4 w-4 text-zp-quaternary" /><div><div className="text-lg font-semibold">{stats?.streak ?? 0} 天</div><div className="text-xs text-zp-quaternary">连续阅读</div></div></div>
      </div>

      {/* 热力图 + 当日明细 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">阅读热力图</h2>
        <div className="overflow-x-auto rounded-md border border-zp-border bg-white p-4 dark:bg-zp-surface">
          <div className="w-max min-w-full">
            <div className="mb-1 ml-7 flex gap-[3px]">
              {weeks.map((col, wi) => {
                const first = col.find((cell) => cell.date.getDate() === 1);
                return <span key={wi} className="h-4 w-3.5 overflow-visible whitespace-nowrap text-[10px] text-zp-quaternary">{first ? first.date.toLocaleDateString("zh-CN", { month: "short" }) : ""}</span>;
              })}
            </div>
            <div className="flex">
              <div className="mr-2 grid grid-rows-7 gap-[3px] text-[10px] leading-3.5 text-zp-quaternary">
                <span /><span>一</span><span /><span>三</span><span /><span>五</span><span />
              </div>
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
                          "h-3.5 w-3.5 rounded-[2px] outline-none ring-offset-1 hover:ring-1 hover:ring-zp-quaternary",
                          HEAT_CLASSES[heatLevel(secs)],
                          isSelected && "ring-2 ring-zp-primary",
                        )}
                      />
                    );
                  })}
                </div>
              ))}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-end gap-1 text-[11px] text-zp-quaternary">
              <span>少</span>
              {HEAT_CLASSES.map((c, i) => (
                <span key={i} className={cn("h-3 w-3 rounded-[3px]", c)} />
              ))}
              <span>多</span>
            </div>
          </div>
        </div>

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
                        <VenueBadge
                          compact
                          venue={paperById.get(p.paper_id)?.venue ?? null}
                          sourceUrl={paperById.get(p.paper_id)?.source_url}
                          iconUrl={paperById.get(p.paper_id)?.source_icon_url}
                          status={p.reading_status as ReadingStatus}
                        />
                        <span className={cn("min-w-0 flex-1 truncate", readingTitleClass(p.reading_status))}>{paperTitle(p,"history",prefs)}</span>
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
                  <VenueBadge compact venue={p.venue} sourceUrl={p.source_url} iconUrl={p.source_icon_url} status={p.reading_status as ReadingStatus} />
                  <span className={cn("min-w-0 flex-1 truncate text-sm", readingTitleClass(p.reading_status))}>{paperTitle(p,"history",prefs)}</span>
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
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const paperMap = useMemo(() => new Map(papers.map((p) => [p.id, p])), [papers]);

  const confirmDelete = () => {
    if (!deleting) return;
    setDeleteError(null);
    deleteReadingPlan(deleting.id)
      .then(onChanged)
      .catch(e => setDeleteError(String(e)))
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

      <Dialog open={showForm} onOpenChange={setShowForm}><DialogContent><DialogHeader><DialogTitle>新建阅读计划</DialogTitle></DialogHeader>
        <PlanForm
          papers={papers}
          onCreated={() => {
            setShowForm(false);
            onChanged();
          }}
          onCancel={() => setShowForm(false)}
        />
      </DialogContent></Dialog>

      {plans.length > 0 && (
        <div className="divide-y divide-zp-border overflow-hidden rounded-xl border border-zp-border bg-white dark:bg-zp-surface">
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

      {deleteError && <p role="alert" className="text-sm text-red-700">{deleteError}</p>}
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
              className="bg-[#b42318] text-white hover:bg-[#912018]"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function PlanCard({ plan, paperMap, todayFinished, onChanged, onDelete, onOpenPaper }: {
  plan: ReadingPlan; paperMap: Map<string, Paper>; todayFinished: number;
  onChanged: () => void; onDelete: () => void; onOpenPaper: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = plan.type === "daily" ? plan.target_count ?? 1 : plan.items.length;
  const done = plan.type === "daily" ? todayFinished : plan.items.filter(item => paperMap.get(item.paper_id)?.reading_status === "read").length;
  const nextDue = plan.items.filter(item => item.due_date && paperMap.get(item.paper_id)?.reading_status !== "read").map(item => item.due_date!).sort((a,b) => a-b)[0];
  const toggle = () => updateReadingPlan(plan.id, { active: !plan.active }).then(onChanged).catch(e => setError(String(e)));
  return <article className="px-4 py-3">
    <div className="flex items-center gap-3">
      <button aria-label="展开计划论文" aria-expanded={expanded} disabled={plan.type === "daily"} onClick={() => setExpanded(value => !value)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium disabled:cursor-default">
        {plan.type === "papers" ? <ChevronDown size={16} className={expanded ? "rotate-180" : ""} /> : <BookCheck size={16} className="text-zp-tertiary" />}
        <span className="truncate">{plan.type === "daily" ? `每天读完 ${total} 篇` : `阅读 ${total} 篇论文`}</span>
      </button>
      <span className="shrink-0 text-xs text-zp-tertiary">{!plan.active ? "已暂停" : nextDue ? formatTime(nextDue) : plan.type === "daily" ? "今日" : ""}</span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-zp-secondary">{done} / {total}</span>
      <IconTooltip label={plan.active ? "暂停计划" : "恢复计划"}><button aria-label={plan.active ? "暂停计划" : "恢复计划"} onClick={toggle} className="rounded-md p-2 text-zp-tertiary hover:bg-zp-subtle">{plan.active ? <Pause size={15} /> : <Play size={15} />}</button></IconTooltip>
      <IconTooltip label="删除计划"><button aria-label="删除计划" onClick={onDelete} className="rounded-md p-2 text-zp-tertiary hover:bg-red-50 hover:text-red-700"><Trash2 size={15} /></button></IconTooltip>
    </div>
    <div role="progressbar" aria-label="计划进度" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={Math.min(done,total)} className="mt-2 h-1 overflow-hidden rounded-full bg-zp-subtle"><div className="h-full rounded-full bg-emerald-600" style={{width: `${total ? Math.min(100,done/total*100) : 0}%`}} /></div>
    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    {expanded && <ul className="mt-3 divide-y divide-zp-border">{plan.items.map(item => {
      const paper = paperMap.get(item.paper_id); const read = paper?.reading_status === "read"; const due = dueBadge(item.due_date, read);
      return <li key={item.paper_id} className="flex items-center gap-2 py-2">
        <button onClick={() => onOpenPaper(item.paper_id)} className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm">
          <VenueBadge compact venue={paper?.venue ?? null} sourceUrl={paper?.source_url} iconUrl={paper?.source_icon_url} status={paper?.reading_status as ReadingStatus} />
          <span className={cn("truncate", read && "text-zp-tertiary")}>{paper ? paperTitle(paper,"history") : "论文已删除"}</span>
        </button>
        {due && <span className={cn("shrink-0 text-xs", due.tone === "red" ? "text-red-700" : "text-zp-tertiary")}>{due.text}</span>}
        <IconTooltip label="从计划移除"><button aria-label="从计划移除" onClick={() => { void removePaperFromPlan(plan.id,item.paper_id).then(onChanged).catch(e => setError(String(e))); }} className="rounded p-1 text-zp-tertiary hover:bg-zp-subtle"><X size={14} /></button></IconTooltip>
      </li>;
    })}</ul>}
  </article>;
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
    <div className="flex flex-col gap-3">
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
                    <span className="min-w-0 flex-1 truncate">{paperTitle(p,"history")}</span>
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
    </div>
  );
}
