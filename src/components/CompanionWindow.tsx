import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, PhysicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PREFERENCES, usePreferences, type Preferences } from "@/lib/preferences";
import { useCompanionTasks, retryCompanionTask, type CompanionTask } from "@/lib/companionTasks";
import { companionPlacement } from "@/lib/companionPlacement";
import { companionEnabled, setCompanionEnabled } from "@/lib/companionPreferences";
import { listJobs, retryJob, type BackgroundJob } from "@/lib/api";
import { ReadingCompanion } from "./ReadingCompanion";
import type { BrowserImportPhase } from "./BrowserImportNotice";

interface Snapshot {
  preferences: Preferences;
  tasks: CompanionTask[];
  jobs: BackgroundJob[];
  notice: { phase: BrowserImportPhase; title: string; message: string } | null;
  readingTitle: string | null;
}
const initial: Snapshot = { preferences: DEFAULT_PREFERENCES, tasks: [], jobs: [], notice: null, readingTitle: null };
export function CompanionBridge(props: Omit<Snapshot, "tasks" | "preferences"> & { onDismiss: () => void; onOpenPaper: (id: string) => void; onImport: () => void; onContinue: () => void }) {
  const tasks = useCompanionTasks();
  const preferences=usePreferences();
  const latest = useRef({ ...props, tasks, preferences }); latest.current = { ...props, tasks, preferences };
  useEffect(() => {
    const send = () => emitTo("companion", "companion:state", {
      preferences:latest.current.preferences, tasks: latest.current.tasks, jobs: latest.current.jobs, notice: latest.current.notice, readingTitle: latest.current.readingTitle,
    });
    const focusMain = async () => { const window = getCurrentWindow(); await window.show(); await window.unminimize(); await window.setFocus(); };
    const preference = () => { void emitTo("companion", "companion:visibility", companionEnabled()); };
    window.addEventListener("companion-preference", preference);
    const handlers = [
      listen<CompanionTask>("companion:retry-local", async ({ payload }) => {
        try { await retryCompanionTask(payload); } catch (error) { void emitTo("companion", "companion:action-error", String(error)); }
      }),
      listen("companion:hide", () => { setCompanionEnabled(false); preference(); }),
      listen("companion:import", async () => { await focusMain(); latest.current.onImport(); }),
      listen("companion:continue", async () => { await focusMain(); latest.current.onContinue(); }),
      listen("companion:ready", () => { void send(); preference(); }),
      listen("companion:dismiss", () => latest.current.onDismiss()),
      listen<string>("companion:open", async ({ payload }) => {
        latest.current.onOpenPaper(payload);
        const window = getCurrentWindow();
        await window.show(); await window.unminimize(); await window.setFocus();
      }),
    ];
    return () => { window.removeEventListener("companion-preference", preference); for (const handler of handlers) void handler.then((unlisten) => unlisten()); };
  }, []);
  useEffect(() => { void emitTo("companion", "companion:state", { preferences, tasks, jobs: props.jobs, notice: props.notice, readingTitle: props.readingTitle }); }, [preferences, tasks, props.jobs, props.notice, props.readingTitle]);
  return null;
}
export function CompanionWindow() {
  const [state, setState] = useState(initial);
  const [bubbleAbove, setBubbleAbove] = useState(false);
  const above = useRef(false); above.current = bubbleAbove;
  const contents = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.classList.add("companion-window");
    const window = getCurrentWindow();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let enabled = companionEnabled();
    const visibility = listen<boolean>("companion:visibility", ({ payload }) => { enabled = payload; void (payload ? window.show() : window.hide()); });
    const pointerRegion = listen<boolean>("companion:pointer-region", ({ payload }) => document.defaultView?.dispatchEvent(new Event(payload ? "companion:pointer-inside" : "companion:pointer-outside")));
    const dragStart = listen("companion:gesture-dragging",()=>document.defaultView?.dispatchEvent(new Event("companion:gesture-dragging")));
    const dragEnd = listen<boolean>("companion:gesture-end",({payload})=>document.defaultView?.dispatchEvent(new CustomEvent("companion:gesture-end",{detail:payload})));
    const actionError = listen<string>("companion:action-error", ({ payload }) => setState(previous => ({ ...previous, notice: { phase: "error", title: "操作失败", message: payload } })));
    const subscription = listen<Snapshot>("companion:state", ({ payload }) => { if (!stopped) setState(payload); });
    void subscription.then(() => emitTo("main", "companion:ready"));
    // Task progress remains available even when the main webview is hidden.
    const poll = async () => {
      try { const jobs = await listJobs(); if (!stopped) setState((prev) => ({ ...prev, jobs })); } catch { /* Reconnect next poll. */ }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    void poll();
    let previousHeight = 0;
    let previousAnchor = 10;
    let resizing = Promise.resolve();
    const measure = () => {
      if (!contents.current) return;
      const regions = [...contents.current.querySelectorAll<HTMLElement>('[data-companion-hit]')].map(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, ellipse: element.dataset.companionHit === 'ellipse', pet: element.dataset.companionHit === 'pet' };
      });
      void invoke('companion_regions', { regions }).catch(() => {});
      const height = Math.ceil(contents.current.getBoundingClientRect().height || 100);
      const anchor = contents.current.querySelector<HTMLElement>("[data-companion-anchor]");
      const anchorY = anchor?.getBoundingClientRect().top ?? 10;
      if (height === previousHeight && anchorY === previousAnchor) return;
      previousHeight = height;
      const oldAnchor = previousAnchor; previousAnchor = anchorY;
      resizing = resizing.then(async () => {
        if (stopped) return;
        const [monitor, position, scale] = await Promise.all([currentMonitor(), window.outerPosition(), window.scaleFactor()]);
        await window.setSize(new LogicalSize(340, height));
        if (monitor) {
          const { x, y, flipAbove } = companionPlacement(position, monitor.workArea, scale, height, oldAnchor, anchorY, above.current);
          if (flipAbove) { setBubbleAbove(true); return; }
          if (x !== position.x || y !== position.y) await window.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
        }
      }).catch(() => {});
    };
    const resize = new ResizeObserver(measure);
    const mutation = new MutationObserver(measure);
    if (contents.current) { resize.observe(contents.current); mutation.observe(contents.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-companion-hit"] }); }
    measure();
    if (enabled) void window.show();
    return () => { stopped = true; clearTimeout(timer); resize.disconnect(); mutation.disconnect(); void pointerRegion.then(unlisten => unlisten()); void dragStart.then(unlisten=>unlisten()); void dragEnd.then(unlisten=>unlisten()); void actionError.then(unlisten => unlisten()); void visibility.then(unlisten => unlisten()); void subscription.then((unlisten) => unlisten()); };
  }, []);
  return <div ref={contents} className="w-[340px] p-[10px]">
    <ReadingCompanion {...state} jobs={state.preferences.petTasks ? [...state.jobs.filter(job=>!state.tasks.some(task=>task.paper_id===job.paper_id&&task.kind===job.kind)).map(job=>({...job,local:job.kind==="full_translation"})), ...state.tasks] : []} readingTitle={state.preferences.petReading ? state.readingTitle : null} notice={state.preferences.petTasks ? state.notice : null} animatePet={state.preferences.petAnimation} bubbleAbove={bubbleAbove}
      onRetryLocal={async task => { const backend=state.jobs.find(j=>j.kind==="full_translation"&&j.paper_id===task.paper_id&&["failed","canceled"].includes(j.status));if(backend)await retryJob(backend.id);else await emitTo("main", "companion:retry-local", task); }} onHide={() => { void getCurrentWindow().hide(); void emitTo("main", "companion:hide"); }}
      onImport={() => { void emitTo("main", "companion:import"); }} onContinue={() => { void emitTo("main", "companion:continue"); }} onNativePress={(x,y)=>invoke('companion_press',{x,y})} onNativeRelease={()=>invoke('companion_release')}
      onDismiss={() => { setState((prev) => ({ ...prev, notice: null })); void emitTo("main", "companion:dismiss"); }}
      onOpenPaper={(id) => { void emitTo("main", "companion:open", id); }} />
  </div>;
}
