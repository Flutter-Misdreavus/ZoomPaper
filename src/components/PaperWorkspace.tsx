import { getPreferences, usePreferences, paperTitle } from "@/lib/preferences";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Library as LibraryIcon, Search, X } from 'lucide-react';
import { Library } from '@/pages/Library';
import { Reader } from '@/pages/Reader';
import { getPaper, listPapers, type BackgroundJob } from '@/lib/api';
import { migrateReaderWorkspace, closeWorkspacePaper, layoutWorkspaceTabs, openWorkspacePaper, restoreWorkspace, type WorkspaceState } from '@/lib/workspace';
import { IconTooltip } from './ui/icon-tooltip';
const MemoLibrary = memo(Library);
const ReaderPane = memo(function ReaderPane({id,active,page,refreshSignal,onBack,onBusy,onTitle}: {id:string;active:boolean;page?:number;refreshSignal:number;onBack:()=>void;onBusy:(id:string,running:boolean)=>void;onTitle:(id:string,title:string)=>void}) {
  const busy=useCallback((running:boolean)=>onBusy(id,running),[id,onBusy]);
  const title=useCallback((value:string)=>onTitle(id,value),[id,onTitle]);
  return <div className="min-h-0 flex-1 flex-col p-6" style={{display:active?'flex':'none'}}><Reader paperId={id} active={active} initialPageIdx={page} refreshSignal={refreshSignal} onBack={onBack} onBusyChange={busy} onTitleChange={title}/></div>;
});
const KEY = 'zoompaper.workspace';
export interface WorkspaceHandle { open: (id: string, page?: number, background?: boolean) => void; resume: () => void; }
export const PaperWorkspace = forwardRef<WorkspaceHandle, { active: boolean; jobs: BackgroundJob[]; refreshSignal: number; onTitleChange: (title: string) => void }>(function PaperWorkspace({ active, jobs, refreshSignal, onTitleChange }, ref) {
  const prefs=usePreferences();
  const [state, setState] = useState(() => getPreferences().restoreTabs ? (localStorage.getItem(KEY) ? restoreWorkspace(localStorage.getItem(KEY)) : migrateReaderWorkspace(localStorage.getItem('zoompaper.readerTabs'))) : restoreWorkspace(null));
  const [papersById, setPapersById]=useState<Record<string, import("@/lib/api").Paper>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<Record<string, number | undefined>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ state: WorkspaceState; visited: Set<string>; count: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState(800);
  const tabSpace = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const listButton = useRef<HTMLButtonElement>(null);
  const validIds = useRef<Set<string> | null>(null);
  const closed = useRef<string[][]>([]);
  const latest = useRef(state); latest.current = state;
  const visited = useRef(visitedTabs); visited.current = visitedTabs;
  useEffect(() => {
    if (active && state.active !== 'library') setVisitedTabs(current => current.has(state.active) ? current : new Set([...current, state.active]));
  }, [active, state.active]);
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);
  useEffect(() => {
    let canceled = false;
    void listPapers().then(papers => {
      if (canceled) return;
      setPapersById(Object.fromEntries(papers.map(p=>[p.id,p])));
      validIds.current = new Set(papers.filter(p => !p.deleted_at).map(p => p.id));
      setTitles(current => ({ ...current, ...Object.fromEntries(papers.map(p => [p.id, p.title])) }));
      setState(current => restoreWorkspace(JSON.stringify({ ...current, tabs: current.tabs.filter(id => validIds.current!.has(id)) })));
    }).catch(() => {});
    return () => { canceled = true; };
  }, [refreshSignal]);
  useEffect(() => {
    const element = tabSpace.current;
    if (!element) return;
    const update = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000); return () => clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    if (!listOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !listButton.current?.contains(target)) setListOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [listOpen]);
  const open = useCallback((id: string, page?: number, background = false) => {
    setPages(prev => ({ ...prev, [id]: page }));
    setState(current => openWorkspacePaper(current, id, background));
    void getPaper(id).then(paper => {setPapersById(prev=>({...prev,[id]:paper}));setTitles(prev => ({ ...prev, [id]: paper.title }));}).catch(() => {});
  }, []);
  const close = (ids: string[]) => {
    if (!ids.length) return;
    closed.current.push(ids);
    setUndo({ state: latest.current, visited: new Set(visited.current), count: ids.length });
    setVisitedTabs(current => new Set([...current].filter(id => !ids.includes(id))));
    setState(current => ids.reduce(closeWorkspacePaper, current));
  };
  const undoClose = () => {
    if (!undo) return;
    const restored = restoreWorkspace(JSON.stringify({ ...undo.state, tabs: undo.state.tabs.filter(id => !validIds.current || validIds.current.has(id)) }));
    setState(current => ({ ...restored, tabs: [...restored.tabs, ...current.tabs.filter(id => !restored.tabs.includes(id))] })); setVisitedTabs(current => new Set([...current, ...undo.visited].filter(id => restored.tabs.includes(id) || latest.current.tabs.includes(id))));
    closed.current.pop(); setUndo(null);
  };
  const reopen = () => {
    const ids = closed.current.pop()?.filter(id => !validIds.current || validIds.current.has(id));
    if (!ids?.length) return;
    setState(current => ids.reduce((next, id) => openWorkspacePaper(next, id, true), current));
    open(ids[0]); setUndo(null);
  };
  useImperativeHandle(ref, () => ({ open, resume: () => {
    const current = latest.current;
    if (current.lastRead) setState({ ...current, active: current.lastRead });
    else void listPapers().then(papers => {
      const recent = papers.filter(p => !p.deleted_at && p.last_read_at).sort((a,b) => (b.last_read_at ?? 0)-(a.last_read_at ?? 0))[0];
      if (recent) open(recent.id);
    }).catch(() => {});
  } }));
  useEffect(() => {
    if (!active) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setListOpen(false); return; }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'w' && latest.current.active !== 'library') { event.preventDefault(); close([latest.current.active]); }
      if (event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); reopen(); }
      if (event.key === 'Tab') {
        event.preventDefault(); const ids = ['library', ...latest.current.tabs];
        const next = ids[(ids.indexOf(latest.current.active) + (event.shiftKey ? ids.length - 1 : 1)) % ids.length];
        setState(current => ({ ...current, active: next, lastRead: next === 'library' ? current.lastRead : next }));
      }
    };
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys);
  }, [active]);
  useEffect(() => { if (active && state.active === 'library') onTitleChange(''); }, [active, state.active, onTitleChange]);
  const readers = [...new Set([
    ...state.tabs.filter(id => visitedTabs.has(id) || (active && state.active === id)), ...busy,
    ...(undo ? undo.state.tabs.filter(id => undo.visited.has(id)) : []),
  ])];
  const shownTitle = (id:string) => papersById[id] ? paperTitle(papersById[id],"tab",prefs) : titles[id] ?? "论文";
  const layout = layoutWorkspaceTabs(state.tabs, state.active, width);
  const select = useCallback((id: string) => { setState(current => ({ ...current, active: id, lastRead: id === 'library' ? current.lastRead : id })); setListOpen(false); },[]);
  const back = useCallback(()=>select('library'),[select]);
  const updateBusy = useCallback((id:string,running:boolean)=>setBusy(current=>{if(current.has(id)===running)return current;const next=new Set(current);if(running)next.add(id);else next.delete(id);return next;}),[]);
  const updateTitle = useCallback((id:string,title:string)=>setTitles(current=>current[id]===title?current:{...current,[id]:title}),[]);
  const openForeground = useCallback((id:string)=>open(id),[open]);
  const openBackground = useCallback((id:string)=>open(id,undefined,true),[open]);
  const openMany = useCallback((ids:string[])=>ids.forEach(id=>open(id,undefined,true)),[open]);
  useEffect(()=>{if(active)onTitleChange(state.active==='library'?'':shownTitle(state.active));},[active,state.active,titles,papersById,prefs,onTitleChange]);
  return <section className="relative min-h-0 min-w-0 flex-1 flex-col" style={{ display: active ? 'flex' : 'none' }} aria-label="论文工作区">
    <div className="relative flex h-11 shrink-0 items-end gap-1 border-b border-zp-border bg-zp-subtle px-3">
      <div role="tablist" aria-label="打开的论文" className="flex min-w-0 flex-1 items-end gap-1">
        <button role="tab" aria-selected={state.active === 'library'} onClick={() => select('library')} className={`flex h-9 w-[104px] shrink-0 items-center justify-center gap-2 rounded-t-lg text-sm ${state.active === 'library' ? 'bg-card text-zp-primary dark:bg-zp-surface' : 'text-zp-tertiary hover:bg-zp-surface-hover'}`}><LibraryIcon size={15} />论文库</button>
        <div ref={tabSpace} className="flex min-w-0 flex-1 items-end overflow-hidden">
          {layout.visible.map(id => <div key={id} style={{ width: layout.widths[id] }} draggable onDragStart={event => event.dataTransfer.setData('text/plain', id)} onDragOver={event => event.preventDefault()} onDrop={event => {
            const from = event.dataTransfer.getData('text/plain'); if (!state.tabs.includes(from) || from === id) return;
            setState(current => { const tabs = current.tabs.filter(tab => tab !== from); tabs.splice(tabs.indexOf(id), 0, from); return { ...current, tabs }; });
          }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close([id]); } }} className={`group flex h-9 min-w-0 shrink-0 items-center rounded-t-lg px-2 ${state.active === id ? 'bg-card dark:bg-zp-surface' : 'text-zp-tertiary hover:bg-zp-surface-hover'}`}>
            <button role="tab" aria-selected={state.active === id} title={shownTitle(id)} onClick={() => select(id)} className="flex min-w-0 flex-1 items-center gap-2 text-sm"><BookOpen size={14} className="shrink-0" /><span className="truncate">{shownTitle(id)}</span></button>
            <IconTooltip label="关闭论文标签"><button aria-label={`关闭 ${shownTitle(id)}`} onClick={() => close([id])} className={`ml-1 shrink-0 rounded p-1 text-zp-tertiary hover:bg-zp-subtle ${state.active === id ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}><X size={13} /></button></IconTooltip>
          </div>)}
        </div>
      </div>
      <div className="mb-1 flex shrink-0 gap-1">
        <IconTooltip label="全部论文标签"><button ref={listButton} aria-label="全部论文标签" aria-expanded={listOpen} onClick={() => { setQuery(''); setListOpen(value => !value); }} className="flex h-8 items-center gap-1 rounded px-2 text-zp-tertiary hover:bg-zp-surface-hover"><ChevronDown size={16} /><span className="text-xs tabular-nums">{state.tabs.length}</span></button></IconTooltip>
        <IconTooltip label="关闭全部论文标签"><button aria-label="关闭全部论文标签" disabled={!state.tabs.length} onClick={() => close([...state.tabs])} className="rounded p-2 text-zp-tertiary hover:bg-zp-surface-hover disabled:opacity-30"><X size={15} /></button></IconTooltip>
      </div>
      {listOpen && <div ref={popup} role="dialog" aria-label="打开的论文列表" className="absolute right-3 top-11 z-50 w-80 max-w-[calc(100vw-90px)] rounded-xl border border-zp-border bg-card p-2 shadow-lg dark:bg-zp-surface">
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-zp-border px-3 py-2 text-zp-tertiary"><Search size={15} /><input autoFocus aria-label="搜索打开的论文" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-zp-primary outline-none" /></label>
        <div className="max-h-80 overflow-y-auto">{state.tabs.filter(id => `${titles[id]??""} ${papersById[id]?.title_zh??""}`.toLowerCase().includes(query.toLowerCase())).map(id => <div key={id} className={`flex items-center rounded-md ${state.active === id ? 'bg-zp-subtle' : ''}`}>
          <button onClick={() => select(id)} title={shownTitle(id)} className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm hover:bg-zp-subtle">{shownTitle(id)}</button>
          <IconTooltip label="关闭论文标签"><button aria-label={`关闭列表中的 ${shownTitle(id)}`} onClick={() => close([id])} className="shrink-0 rounded p-2 text-zp-tertiary hover:bg-zp-subtle"><X size={13} /></button></IconTooltip>
        </div>)}</div>
      </div>}
    </div>
    <div className="min-h-0 flex-1" style={{ display: state.active === 'library' ? 'flex' : 'none' }}><MemoLibrary refreshSignal={refreshSignal} jobs={jobs} onOpenPaper={openForeground} onOpenBackground={openBackground} onOpenPapers={openMany} /></div>
    {readers.map(id => <ReaderPane key={id} id={id} active={active && state.active === id} page={pages[id]} refreshSignal={refreshSignal} onBack={back} onBusy={updateBusy} onTitle={updateTitle}/>)}
    {undo && <div role="status" className="absolute bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 whitespace-nowrap rounded-xl border border-zp-border bg-card px-4 py-3 text-sm shadow-md dark:bg-zp-surface">已关闭 {undo.count} 个标签<button onClick={undoClose} className="font-medium text-zp-primary hover:underline">撤销</button></div>}
  </section>;
});
