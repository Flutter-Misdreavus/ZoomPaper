export interface WorkspaceState { tabs: string[]; active: string; lastRead: string | null; }
export const EMPTY_WORKSPACE: WorkspaceState = { tabs: [], active: 'library', lastRead: null };
export function restoreWorkspace(raw: string | null): WorkspaceState {
  try { const state = JSON.parse(raw ?? '{}'); const tabs = [...new Set<string>((Array.isArray(state.tabs) ? state.tabs : []).filter((id: unknown) => typeof id === 'string'))];
    return { tabs, active: tabs.includes(state.active) ? state.active : 'library', lastRead: tabs.includes(state.lastRead) ? state.lastRead : tabs[tabs.length - 1] ?? null };
  } catch { return EMPTY_WORKSPACE; }
}
export function openWorkspacePaper(state: WorkspaceState, id: string, background = false): WorkspaceState {
  return { tabs: state.tabs.includes(id) ? state.tabs : [...state.tabs, id], active: background ? state.active : id, lastRead: background ? state.lastRead : id };
}
export function closeWorkspacePaper(state: WorkspaceState, id: string): WorkspaceState {
  const index = state.tabs.indexOf(id), tabs = state.tabs.filter((tab) => tab !== id);
  const active = state.active === id ? tabs[Math.max(0, index - 1)] ?? 'library' : state.active;
  return { tabs, active, lastRead: state.lastRead === id ? (active !== 'library' ? active : tabs[tabs.length - 1] ?? null) : state.lastRead };
}

/** Give the active tab enough room, then expose the remaining tabs through the searchable list. */
export function layoutWorkspaceTabs(tabs: string[], active: string, width: number) {
  if (!tabs.length || width <= 0) return { visible: [] as string[], widths: {} as Record<string, number> };
  const activeWidth = Math.min(tabs.length * 220 <= width ? 220 : 160, width);
  const capacity = width >= activeWidth + (tabs.length - 1) * 110 ? tabs.length : Math.max(1, 1 + Math.floor((width - activeWidth) / 110));
  const index = Math.max(0, tabs.indexOf(active));
  const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), tabs.length - capacity));
  const visible = tabs.slice(start, start + capacity);
  const hasActive = visible.includes(active);
  const normalWidth = Math.min(220, (width - (hasActive ? activeWidth : 0)) / Math.max(1, visible.length - (hasActive ? 1 : 0)));
  return { visible, widths: Object.fromEntries(visible.map(id => [id, id === active ? activeWidth : normalWidth])) };
}

export function migrateReaderWorkspace(raw: string | null): WorkspaceState {
 try {const previous=JSON.parse(raw??'{}');const tabs=(Array.isArray(previous.tabs)?previous.tabs:[]).filter((t:any)=>t&&typeof t.paperId==='string');const active=tabs.find((t:any)=>t.id===previous.activeTabId)?.paperId??'library';return restoreWorkspace(JSON.stringify({tabs:tabs.map((t:any)=>t.paperId),active,lastRead:active==='library'?tabs.at(-1)?.paperId:active}));}catch{return EMPTY_WORKSPACE;}
}
