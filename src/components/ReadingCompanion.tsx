import { useEffect, useRef, useState } from "react";
import { motion, useDragControls, useReducedMotion } from "motion/react";
import { BookOpen, Upload, RotateCcw, X } from "lucide-react";
import { cancelJob, retryJob } from "@/lib/api";
import type { CompanionTask } from "@/lib/companionTasks";
import type { BrowserImportPhase } from "./BrowserImportNotice";
import { IconTooltip } from "@/components/ui/icon-tooltip";

const stages: Record<string, string> = {
  queued: "等待处理", uploading: "正在上传", pending: "云端排队", converting: "正在转换",
  running: "正在解析", downloading: "正在获取正文", reconnecting: "正在重连",
};
const kinds: Record<string, string> = { parse: "解析", index: "建立索引", translate: "翻译标题与摘要", doi: "补全出版信息", blog: "生成博客", full_translation: "翻译全文" };
const active = (job: CompanionTask) => job.status === "queued" || job.status === "running" || job.status === "canceling";
export function jobLabel(job: CompanionTask) {
  if (job.status === "canceling") return "正在停止";
  if (job.status === "failed") return `${kinds[job.kind]}失败`;
  if (job.status === "canceled") return "已取消";
  if (job.status === "done") return `${kinds[job.kind]}完成`;
  return job.status === "queued" ? "等待处理" : job.kind === "parse" ? stages[job.stage] || "正在解析" : `正在${kinds[job.kind]}`;
}
/** Repo-native vector character: no remote assets, animation respects reduced motion. */
type BirdState = "idle" | "reading" | "working" | "success" | "error" | "sleep";
function PaperBird({ state, animatePet }: { state: BirdState; animatePet: boolean }) {
  const systemReduced = useReducedMotion();
  const reduced = systemReduced || !animatePet;
  return <motion.svg viewBox="0 0 100 100" className="pointer-events-none h-[76px] w-[76px] drop-shadow-sm" aria-hidden="true"
    animate={reduced ? {} : state === "working" ? { y: [0, -3, 0], rotate: [0, -2, 0, 2, 0] } : state === "reading" ? { rotate: [0, 3, 0] } : state === "success" ? { y: [0, 3, 0] } : { y: 0, rotate: state === "error" ? -8 : 0 }}
    transition={{ duration: 3, repeat: state === "success" ? 0 : Infinity, ease: "easeInOut" }}>
    <ellipse cx="51" cy="88" rx="25" ry="4" fill="#000" opacity=".07" />
    <path d="M32 74l-3 10m37-10 4 10" stroke="#617369" strokeWidth="4" strokeLinecap="round" />
    <path d="M22 33Q17 59 30 75Q50 87 70 75Q83 58 78 33L69 24H31Z" fill="#f8faf7" stroke="#a9b8ad" strokeWidth="2" />
    <path d="M23 35l8-17 13 12m33 5-8-17-13 12" fill="#dce7d9" stroke="#a9b8ad" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="37" cy="45" r="12" fill="#e9efe6" /><circle cx="63" cy="45" r="12" fill="#e9efe6" />
    <motion.g animate={systemReduced ? {} : { scaleY: state === "sleep" ? 0.08 : [1, 1, 0.08, 1] }} transition={{ duration: 5, times: [0, 0.92, 0.96, 1], repeat: Infinity }} style={{ transformOrigin: "50px 46px" }}>
    <circle cx="38" cy="46" r="4" fill="#34443b" /><circle cx="62" cy="46" r="4" fill="#34443b" />
    <circle cx="39" cy="44" r="1.3" fill="white" /><circle cx="63" cy="44" r="1.3" fill="white" />
    </motion.g>
    <path d="M46 53l4 5 4-5" fill="#d6a35e" />
    <path d="M25 59l23 5 25-5v18l-25 5-23-5Z" fill="#426554" stroke="#345142" strokeWidth="1.5" strokeLinejoin="round" />
    <motion.path animate={state === "reading" && !reduced ? { opacity: [1, 0.3, 1] } : { opacity: 1 }} transition={{duration: 2, repeat: Infinity}} d="M48 64v18m-19-19 14 3m10 0 15-3" stroke="#e5ecdf" strokeWidth="2" strokeLinecap="round" />
    <motion.path animate={state === "working" && !reduced ? { rotate: [0, -6, 0, 6, 0] } : { rotate: 0 }} style={{transformOrigin: "50px 64px"}} transition={{duration: 2, repeat: Infinity}} d="M19 58q-4 11 10 13m52-13q4 11-10 13" stroke="#bacabb" strokeWidth="6" fill="none" strokeLinecap="round" />
  </motion.svg>;
}
interface Props {
  jobs: CompanionTask[];
  notice: { phase: BrowserImportPhase; title: string; message: string; sourceUrl?: string } | null;
  readingTitle: string | null;
  onDismiss: () => void;
  onOpenPaper: (paperId: string) => void;
  onNativePress?: (x:number,y:number)=>Promise<unknown>;
  onNativeRelease?: ()=>Promise<unknown>;
  onNativeDrag?: () => void | Promise<void>;
  onImport?: () => void;
  onContinue?: () => void;
  onHide?: () => void;
  onRetryLocal?: (task: CompanionTask) => Promise<void>;
  bubbleAbove?: boolean;
  animatePet?: boolean;
}
export function ReadingCompanion({ jobs, notice, readingTitle, onDismiss, onOpenPaper, onNativePress, onNativeRelease, onNativeDrag, onImport, onContinue, onHide, onRetryLocal, bubbleAbove = false, animatePet = true }: Props) {
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;
  const dragControls = useDragControls();
  const container = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const [finished, setFinished] = useState<CompanionTask | null>(null);
  const previousJobs = useRef(new Map<string, string>());
  const [quick, setQuick] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reveal = () => { if(pointer.current?.dragged)return; if (leaveTimer.current) clearTimeout(leaveTimer.current); setQuick(true); };
  const conceal = () => { if(pointer.current)return; if (leaveTimer.current) clearTimeout(leaveTimer.current); leaveTimer.current = setTimeout(() => setQuick(false), 250); };
  useEffect(() => {
    window.addEventListener("companion:pointer-inside", reveal); window.addEventListener("companion:pointer-outside", conceal);
    return () => { window.removeEventListener("companion:pointer-inside", reveal); window.removeEventListener("companion:pointer-outside", conceal); if (leaveTimer.current) clearTimeout(leaveTimer.current); };
  }, []);
  const [sleeping, setSleeping] = useState(false);
  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  useEffect(() => { setSleeping(false); const timer = setTimeout(() => setSleeping(true), 60000); return () => clearTimeout(timer); }, [jobs.map(job => `${job.id}:${job.status}`).join("|"), readingTitle, quick]);
  useEffect(()=>{
    const dragging=()=>{if(pointer.current)pointer.current.dragged=true;if(leaveTimer.current)clearTimeout(leaveTimer.current);setQuick(false);};
    const ended=(event:Event)=>{pointer.current=null;if(!(event as CustomEvent<boolean>).detail){if(leaveTimer.current)clearTimeout(leaveTimer.current);setQuick(true);}};
    window.addEventListener('companion:gesture-dragging',dragging);window.addEventListener('companion:gesture-end',ended);
    return()=>{window.removeEventListener('companion:gesture-dragging',dragging);window.removeEventListener('companion:gesture-end',ended);};
  },[]);
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      const element = container.current;
      if (!element) return;
      setBounds({ left: -Math.max(0, window.innerWidth - element.offsetWidth - 40), right: 0,
        top: 0, bottom: Math.max(0, window.innerHeight - element.offsetHeight - 40) });
    };
    const observer = new ResizeObserver(update);
    if (container.current) observer.observe(container.current);
    window.addEventListener("resize", update); update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    const terminal = jobs.find((job) => !active(job) && ["queued", "running", "canceling"].includes(previousJobs.current.get(job.id) || ""));
    previousJobs.current = new Map(jobs.map((job) => [job.id, job.status]));
    if (terminal) { setFinished(terminal); setMinimized(false); }
  }, [jobs]);
  useEffect(() => {
    if (!finished || expanded || finished.status === "failed") return;
    const timer = setTimeout(() => setFinished(null), 5000);
    return () => clearTimeout(timer);
  }, [finished, expanded]);
  const pending = jobs.filter(active);
  const failed = jobs.filter(job => job.status === "failed").sort((a,b) => b.updated_at-a.updated_at)[0];
  const current = pending.find((job) => job.status === "running" && job.kind === "parse") || pending.find((job) => job.status === "running") || pending[0];
  const busy = pending.length > 0 || notice?.phase === "downloading";
  const count = new Set(pending.map((job) => job.paper_id)).size;
  const title = notice?.phase === "downloading" ? `正在导入 ${notice.title}`
    : current ? `${jobLabel(current)} ${current.title}${pending.length > 1 ? ` · 另有 ${pending.length - 1} 个任务` : ""}`
    : failed ? `${jobLabel(failed)} ${failed.title}`
    : notice?.phase === "error" ? `导入失败 ${notice.title}`
    : notice?.phase === "done" ? `已导入 ${notice.title}`
    : finished ? `${jobLabel(finished)} ${finished.title}` : readingTitle ? `正在阅读 ${readingTitle}` : "阅读伙伴";
  useEffect(() => {
    if (notice?.phase !== "done") return;
    const timer = setTimeout(() => dismissRef.current(), 5000); return () => clearTimeout(timer);
  }, [notice?.phase, notice?.title]);
  const minimize = () => { setMinimized(true); setExpanded(false); setFinished(null); onDismiss(); };
  const act = async (operation: () => Promise<void>) => {
    setError(null); try { await operation(); } catch (e) { setError(String(e)); }
  };
  const visibleJobs = [...pending, ...jobs.filter((job) => ["failed", "canceled"].includes(job.status)).slice(0, 3)];
  const showBubble = busy || notice != null || finished != null || !!readingTitle || !!failed;
  return <motion.div ref={container} className={onNativeDrag || onNativePress ? "w-[320px] max-w-full select-none" : "fixed top-5 right-5 z-[90] w-[320px] max-w-[calc(100vw-40px)] select-none"}
    onPointerEnter={reveal} onPointerLeave={conceal} onFocusCapture={reveal} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) conceal(); }}
    drag={!onNativeDrag && !onNativePress} dragControls={dragControls} dragListener={false} dragMomentum={false} dragConstraints={bounds}>
    <div className="flex flex-col items-center gap-2">
      <div data-companion-anchor className="group relative">
        <div data-companion-hit="pet" role="button" tabIndex={0} aria-label="阅读伙伴" aria-expanded={quick}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setQuick(value => !value); } }}
          onPointerDown={event => { if (event.button !== 0) return; setSleeping(false); pointer.current = { x: event.screenX, y: event.screenY, dragged: false }; event.currentTarget.setPointerCapture?.(event.pointerId); if(onNativePress){event.preventDefault();void onNativePress(event.clientX,event.clientY).catch(error=>{pointer.current=null;setError(String(error));});} else if (!onNativeDrag) dragControls.start(event, { distanceThreshold: 1 }); }}
          onPointerMove={event => { if(onNativePress)return; const start = pointer.current; if (start && !start.dragged && Math.hypot(event.screenX-start.x, event.screenY-start.y) >= 1) { start.dragged = true; setQuick(false); if (leaveTimer.current)clearTimeout(leaveTimer.current); if(onNativeDrag){event.currentTarget.releasePointerCapture?.(event.pointerId); void Promise.resolve(onNativeDrag()).catch(error=>setError(String(error))).finally(()=>{if(pointer.current===start)pointer.current=null;});} } }}
          onPointerUp={event => { if(onNativePress){void onNativeRelease?.().catch(error=>setError(String(error)));return;} const start=pointer.current; pointer.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId); if(start && !start.dragged){if(leaveTimer.current)clearTimeout(leaveTimer.current);setQuick(true);} }}
          onPointerCancel={() => { if(onNativePress)void onNativeRelease?.(); pointer.current = null; }}
          className="touch-none cursor-grab rounded-full outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 active:cursor-grabbing">
          <PaperBird animatePet={animatePet} state={busy ? "working" : notice?.phase === "error" || finished?.status === "failed" ? "error" : finished?.status === "done" || notice?.phase === "done" ? "success" : readingTitle ? "reading" : sleeping ? "sleep" : "idle"} />
        </div>
        {onHide && <IconTooltip label="隐藏阅读伙伴"><button data-companion-hit="ellipse" aria-label="隐藏阅读伙伴" onClick={onHide} className="absolute right-0 top-0 rounded-full bg-white/80 p-1 text-zp-tertiary opacity-0 group-hover:opacity-100 focus:opacity-100"><X size={12} /></button></IconTooltip>}
        {quick && <div className="pointer-events-none absolute top-9 left-1/2 flex -translate-x-1/2 gap-[90px]">
          <IconTooltip label="导入论文"><button data-companion-hit="rectangle" aria-label="导入论文" onClick={() => { onImport?.(); setQuick(false); }} className="pointer-events-auto companion-glass flex h-9 w-11 items-center justify-center rounded-xl text-zp-primary hover:brightness-105"><Upload size={20} /></button></IconTooltip>
          <IconTooltip label="继续阅读"><button data-companion-hit="rectangle" aria-label="继续阅读" onClick={() => { onContinue?.(); setQuick(false); }} className="pointer-events-auto companion-glass flex h-9 w-11 items-center justify-center rounded-xl text-zp-primary hover:brightness-105"><BookOpen size={20} /></button></IconTooltip>
        </div>}
      </div>
      {showBubble && (minimized ? <IconTooltip label={title}><button data-companion-hit="rectangle" aria-label="展开阅读伙伴" onClick={() => setMinimized(false)} className={`flex h-8 items-center gap-2 rounded-full border border-zp-border companion-glass px-3 ${bubbleAbove ? "order-first" : ""}`}><BookOpen size={16} />{count > 0 && <span className="text-xs">{count}</span>}</button></IconTooltip>
        : <section data-companion-hit="rectangle" aria-label="任务气泡" className={`companion-glass w-full rounded-3xl px-4 py-3 ${bubbleAbove ? "order-first" : ""}`}>
          <div className="flex items-start gap-2">
            <button aria-label={expanded ? "收起任务内容" : "展开任务内容"} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className={`min-w-0 flex-1 text-left text-[13px] leading-5 break-words ${expanded ? "" : "line-clamp-2"}`} title={title}>{title}</button>
            <IconTooltip label="收起气泡"><button aria-label="关闭提示" onClick={minimize} className="mt-0.5 rounded-md p-0.5 text-zp-tertiary hover:bg-zp-subtle"><X size={13} /></button></IconTooltip>
          </div>
          {expanded && notice?.phase === "error" && <p className="mt-1 break-words text-xs text-amber-700">{notice.message}</p>}
          {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
          {expanded && readingTitle && <p className="mt-2 text-xs leading-5 text-zp-tertiary">正在阅读 {readingTitle}</p>}
          {expanded && visibleJobs.length > 0 && <div className="mt-2 max-h-[180px] space-y-2 overflow-y-auto">
            {visibleJobs.map((job) => <div key={job.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {job.id !== current?.id && <p className="text-xs leading-5 break-words">{job.title}</p>}
                <p className={`text-xs leading-5 ${job.status === "failed" ? "text-amber-600" : "text-zp-tertiary"}`}>{jobLabel(job)}{job.completed_pages != null && job.total_pages ? ` · ${job.completed_pages}/${job.total_pages} ${job.kind === "full_translation" ? "段" : "页"}` : ""}</p>
                {job.error && <p className="break-words text-xs leading-5 text-zp-secondary">{job.error}</p>}
              </div>
              <IconTooltip label="打开论文"><button aria-label={`打开 ${job.title}`} onClick={() => onOpenPaper(job.paper_id)} className="rounded-md p-1 text-zp-tertiary hover:bg-zp-subtle"><BookOpen size={14} /></button></IconTooltip>
              {active(job) && !job.local && job.status !== "canceling" ? <IconTooltip label="取消任务"><button aria-label={`取消 ${kinds[job.kind]}`} onClick={() => void act(() => cancelJob(job.id))} className="rounded-md p-1 text-zp-tertiary hover:bg-zp-subtle"><X size={14} /></button></IconTooltip>
                : ["failed", "canceled"].includes(job.status) && <IconTooltip label="重试任务"><button aria-label={`重试 ${kinds[job.kind]}`} onClick={() => void act(() => job.local && onRetryLocal ? onRetryLocal(job) : retryJob(job.id))} className="rounded-md p-1 text-zp-tertiary hover:bg-zp-subtle"><RotateCcw size={14} /></button></IconTooltip>}
            </div>)}
          </div>}
        </section>)}
    </div>
  </motion.div>;
}
