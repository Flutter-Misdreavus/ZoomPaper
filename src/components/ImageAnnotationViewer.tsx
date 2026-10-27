import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { resolveImgSrc } from "@/lib/markdown";
import { getImageAnnotationStore, imageKey, type ImageMark, type ImagePoint } from "@/lib/imageAnnotations";

type ImageTarget = { key: string; src: string; alt: string };
const ImageContext = createContext<{ baseDir: string; open: (src: string, alt: string) => void; hasMarks: (src: string) => boolean } | null>(null);

export function AnnotatableImage({ src, alt = "" }: { src?: string; alt?: string }) {
  const context = useContext(ImageContext);
  if (!context || !src) return <img src={src} alt={alt} />;
  return <span className="relative inline-block max-w-full">
    <img src={resolveImgSrc(src, context.baseDir)} alt={alt} role="button" tabIndex={0} aria-label={`放大图片：${alt || "论文图片"}`} className="cursor-zoom-in" onClick={e => { e.preventDefault(); e.stopPropagation(); e.currentTarget.focus({ preventScroll: true }); context.open(src, alt); }} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); e.currentTarget.focus({ preventScroll: true }); context.open(src, alt); } }} />
    {context.hasMarks(src) && <span aria-label="有标注" data-label="有标注" className="pointer-events-none absolute right-2 top-2 rounded bg-background/90 px-2 py-1 text-xs text-foreground shadow after:content-[attr(data-label)]" />}
  </span>;
}

export function ImageAnnotationProvider({ paperId, baseDir, active, children }: { paperId: string; baseDir: string; active: boolean; children: ReactNode }) {
  const store = getImageAnnotationStore(paperId);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const opener = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<ImageTarget | null>(null);
  useEffect(() => { void store.load(); }, [store]);
  useEffect(() => { if (!active) setTarget(null); }, [active]);
  return <ImageContext.Provider value={{ baseDir, hasMarks: src => !!snapshot.images[imageKey(src, baseDir)]?.length, open: (src, alt) => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setTarget({ key: imageKey(src, baseDir), src: resolveImgSrc(src, baseDir) ?? src, alt }); } }}>
    {children}
    <Dialog open={!!target && active} onOpenChange={open => { if (!open) setTarget(null); }}>
      {target && <ImageEditor key={target.key} target={target} marks={snapshot.images[target.key] ?? []} editable={snapshot.loaded} status={snapshot.status} error={snapshot.error} restoreFocus={() => opener.current?.focus({ preventScroll: true })} retry={() => { if (snapshot.loaded) void store.retry(); else void store.load(); }} change={marks => store.update(target.key, marks)} />}
    </Dialog>
  </ImageContext.Provider>;
}

function upsertNote(marks: ImageMark[], note: { id: string; point: ImagePoint; text: string }): ImageMark[] {
  const next: ImageMark = { ...note, kind: "note", text: note.text.trim() };
  return marks.some(m => m.id === note.id) ? marks.map(m => m.id === note.id ? next : m) : [...marks, next];
}

type Mode = "view" | "pen" | "note" | "delete";
function ImageEditor({ target, marks, editable, status, error, retry, change, restoreFocus }: { target: ImageTarget; marks: ImageMark[]; editable: boolean; status: string; error: string | null; retry: () => void; restoreFocus: () => void; change: (marks: ImageMark[]) => void }) {
  const [mode, setMode] = useState<Mode>("view");
  const [color, setColor] = useState("#ef4444");
  const [width, setWidth] = useState(0.004);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<ImageMark | null>(null);
  const [note, setNote] = useState<{ id: string; point: ImagePoint; text: string } | null>(null);
  const [past, setPast] = useState<ImageMark[][]>([]);
  const [future, setFuture] = useState<ImageMark[][]>([]);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const image = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; startX: number; startY: number; pan: ImagePoint; stroke?: Extract<ImageMark, { kind: "stroke" }> } | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const changeRef = useRef(change);
  changeRef.current = change;
  // 关闭时提交尚在编辑的非空备注，避免点击遮罩或按 Esc 时丢失输入。
  useEffect(() => () => {
    const pending = noteRef.current;
    if (pending?.text.trim()) changeRef.current(upsertNote(marksRef.current, pending));
  }, []);
  // Dialog 的 Portal 延后挂载内容，必须在画布节点就绪后再测量和监听。
  useLayoutEffect(() => {
    if (!stage) return;
    setViewport({ w: stage.clientWidth, h: stage.clientHeight });
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      setViewport({ w: rect.width, h: rect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  const viewportReady = viewport.w > 32 && viewport.h > 32;
  const fit = size.w ? Math.min(viewport.w / size.w, viewport.h / size.h) : 1;
  const aspectRatio = size.w && size.h ? size.w / size.h : 1.6;
  const scale = Math.max(0.001, fit) * zoom;
  const commit = (next: ImageMark[]) => { setPast(p => [...p, marks]); setFuture([]); change(next); };
  const pointAt = (e: ReactPointerEvent): ImagePoint => {
    const r = image.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const finishNote = () => {
    if (!note) return;
    if (note.text.trim()) commit(upsertNote(marks, note));
    noteRef.current = null; setNote(null);
  };
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !size.w || failed || !viewportReady || note) return;
    if (mode !== "view" && !editable) return;
    if (mode === "note") { setNote({ id: crypto.randomUUID(), point: pointAt(e), text: "" }); return; }
    if (mode === "delete") return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    const stroke = mode === "pen" ? { id: crypto.randomUUID(), kind: "stroke" as const, points: [pointAt(e)], color, width } : undefined;
    gesture.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, pan, stroke };
    if (stroke) setDraft(stroke);
  };
  const cancelGesture = () => { gesture.current = null; setDraft(null); };
  const tool = (value: Mode, label: string) => <button type="button" aria-pressed={mode === value} disabled={value !== "view" && !editable} onClick={() => { finishNote(); cancelGesture(); setMode(value); }} className={`rounded px-3 py-1.5 text-sm disabled:opacity-40 ${mode === value ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{label}</button>;
  const notes = marks.filter((m): m is Extract<ImageMark, { kind: "note" }> => m.kind === "note");
  return <DialogContent showCloseButton={false} overlayClassName="bg-black/50" className="block max-w-none rounded-xl border-0 bg-white p-3 shadow-2xl sm:rounded-xl sm:p-4" style={{ width: `min(94vw, calc((100dvh - 200px) * ${aspectRatio} + 32px))` }} aria-describedby={undefined} onCloseAutoFocus={e => { e.preventDefault(); restoreFocus(); }} onFocusOutside={e => e.preventDefault()}>
    <DialogTitle className="sr-only">{target.alt || "论文图片"}</DialogTitle>
    <div className="absolute left-1/2 top-full mt-3 flex w-max max-w-[94vw] -translate-x-1/2 flex-col items-center gap-2">
    <div role="toolbar" aria-label="图片工具" className="flex max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border bg-background/95 p-1.5 shadow-lg backdrop-blur">
      {tool("view", "查看")}{tool("pen", "画笔")}{tool("note", "位置备注")}{tool("delete", "删除")}
      <button disabled={!past.length || !!note} className="px-2 disabled:opacity-40" onClick={() => { cancelGesture(); const previous = past[past.length - 1]; setPast(past.slice(0, -1)); setFuture(f => [...f, marks]); change(previous); }}>撤销</button>
      <button disabled={!future.length || !!note} className="px-2 disabled:opacity-40" onClick={() => { cancelGesture(); const next = future[future.length - 1]; setFuture(future.slice(0, -1)); setPast(p => [...p, marks]); change(next); }}>重做</button>
      {mode === "pen" && <>
        {([ ["#ef4444", "红色"], ["#eab308", "黄色"], ["#3b82f6", "蓝色"], ["#22c55e", "绿色"] ] as const).map(([c, label]) => <button key={c} aria-label={label} aria-pressed={color === c} onClick={() => setColor(c)} className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-foreground" : "border-transparent"}`} style={{ background: c }} />)}
        <select aria-label="画笔粗细" className="bg-background text-sm" value={width} onChange={e => setWidth(Number(e.target.value))}><option value={0.002}>细</option><option value={0.004}>中</option><option value={0.008}>粗</option></select>
      </>}
      <div className="ml-auto flex items-center gap-2 text-sm">
        <button aria-label="缩小图片" onClick={() => setZoom(z => Math.max(0.25, z / 1.25))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大图片" onClick={() => setZoom(z => Math.min(16, z * 1.25))}>＋</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>复位</button>
      </div>
    </div>
    <div className={`flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-xs ${error ? "bg-background text-foreground shadow" : "text-white/80"}`} role="status"><span>{status}</span>{error && <><span className="text-destructive">{error}</span><button className="underline" onClick={retry}>重试</button></>}</div>
    </div>
    <div ref={setStage} className="relative w-full overflow-hidden rounded-sm bg-white text-neutral-700" style={{ aspectRatio }} onWheel={e => { if (note) return; setZoom(z => Math.max(0.25, Math.min(16, z * Math.exp(-e.deltaY * 0.002)))); }}>
      {(!size.w || !viewportReady) && !failed && <p className="absolute inset-0 flex items-center justify-center">正在加载图片…</p>}
      {failed && <p role="alert" className="absolute inset-0 flex items-center justify-center">图片加载失败，请关闭后重试</p>}
      <div ref={image} className="absolute select-none" style={{ width: size.w * scale || 1, height: size.h * scale || 1, left: "50%", top: "50%", transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`, touchAction: "none", cursor: mode === "view" ? "grab" : "crosshair", visibility: failed || !size.w || !viewportReady ? "hidden" : "visible" }}
        onPointerDown={start}
        onPointerMove={e => {
          const g = gesture.current;
          if (!g || g.id !== e.pointerId) return;
          if (g.stroke) { g.stroke = { ...g.stroke, points: [...g.stroke.points, pointAt(e)] }; setDraft(g.stroke); }
          else setPan({ x: g.pan.x + e.clientX - g.startX, y: g.pan.y + e.clientY - g.startY });
        }}
        onPointerUp={e => { const g = gesture.current; if (!g || g.id !== e.pointerId) return; if (g.stroke) { const stroke = { ...g.stroke, points: [...g.stroke.points, pointAt(e)] }; commit([...marks, stroke]); } cancelGesture(); }}
        onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
        <img draggable={false} className="block h-full w-full max-w-none" src={target.src} alt={target.alt} onLoad={e => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="图片笔迹">
          {[...marks, ...(draft ? [draft] : [])].map(m => m.kind === "stroke" && <g key={m.id}>
            <path d={`M ${m.points.map(p => `${p.x} ${p.y}`).join(" L ")}`} fill="none" stroke={m.color} strokeWidth={m.width} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
            {mode === "delete" && <path d={`M ${m.points.map(p => `${p.x} ${p.y}`).join(" L ")}`} fill="none" stroke="transparent" strokeWidth={Math.max(m.width, 0.02)} pointerEvents="stroke" role="button" aria-label="删除笔迹" tabIndex={0} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); commit(marks.filter(x => x.id !== m.id)); }} onKeyDown={e => { if (e.key === "Enter" || e.key === "Delete") commit(marks.filter(x => x.id !== m.id)); }} />}
          </g>)}
        </svg>
        {notes.map((m, i) => <button key={m.id} aria-label={`备注 ${i + 1}：${m.text}`} className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-primary text-xs text-primary-foreground shadow" style={{ left: `${m.point.x * 100}%`, top: `${m.point.y * 100}%` }} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); if (mode === "delete" && editable) commit(marks.filter(x => x.id !== m.id)); else { finishNote(); setNote({ id: m.id, point: m.point, text: m.text }); } }}>{i + 1}</button>)}
      </div>
      {note && <div className="absolute bottom-3 right-3 flex w-72 max-w-[90%] flex-col gap-2 rounded-lg border bg-background p-3 shadow-lg">
        <label className="text-sm">位置备注<textarea autoFocus aria-label="备注内容" readOnly={!editable} className="mt-2 min-h-24 w-full rounded border bg-background p-2 text-sm" value={note.text} onChange={e => setNote({ ...note, text: e.target.value })} /></label>
        <div className="flex justify-end gap-3 text-sm">
          {marks.some(m => m.id === note.id) && <button disabled={!editable} onClick={() => { commit(marks.filter(m => m.id !== note.id)); noteRef.current = null; setNote(null); }}>删除</button>}
          <button onClick={() => { noteRef.current = null; setNote(null); }}>取消</button><button disabled={!editable || !note.text.trim()} onClick={finishNote}>保存备注</button>
        </div>
      </div>}
    </div>
    <p className="sr-only">{mode === "view" ? "拖动查看，滚轮缩放" : mode === "pen" ? "在图上按住并拖动画笔" : mode === "note" ? "点击图中位置添加备注" : "点击笔迹或备注编号删除"}</p>
  </DialogContent>;
}
