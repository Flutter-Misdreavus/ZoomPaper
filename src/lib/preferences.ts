import { useSyncExternalStore } from 'react';
import type { Paper } from './api';
import { displayPaperTitle } from './utils';
export type DisplayLanguage = 'original' | 'zh' | 'both';
export interface Preferences {
    titleLanguage: DisplayLanguage;
    libraryLanguage: DisplayLanguage | 'inherit';
    tabLanguage: DisplayLanguage | 'inherit';
    detailLanguage: DisplayLanguage | 'inherit';
    historyLanguage: DisplayLanguage | 'inherit';
    abstractLanguage: DisplayLanguage;
    restoreTabs: boolean;
    markReading: boolean;
    markReadAtEnd: boolean;
    showAssistant: boolean;
    petAnimation: boolean;
    petReading: boolean;
    petTasks: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = { titleLanguage: 'zh', libraryLanguage: 'inherit', tabLanguage: 'inherit', detailLanguage: 'inherit', historyLanguage: 'inherit', abstractLanguage: 'zh', restoreTabs: true, markReading: true, markReadAtEnd: false, showAssistant: true, petAnimation: true, petReading: true, petTasks: true };
const KEY = 'zoompaper.preferences';
let raw: string | null | undefined, cached = DEFAULT_PREFERENCES;
export function getPreferences(): Preferences {
    const next = localStorage.getItem(KEY);
    if (next === raw)
        return cached;
    raw = next;
    try {
        const value = JSON.parse(next ?? '{}');
        cached = { ...DEFAULT_PREFERENCES };
        for (const key of Object.keys(cached) as (keyof Preferences)[]) {
            const v = value?.[key];
            if (typeof cached[key] === 'boolean' ? typeof v === 'boolean' : ['original', 'zh', 'both', ...(['libraryLanguage', 'tabLanguage', 'detailLanguage', 'historyLanguage'].includes(key) ? ['inherit'] : [])].includes(v))
                (cached as any)[key] = v;
        }
    }
    catch {
        cached = DEFAULT_PREFERENCES;
    }
    return cached;
}
export function setPreferences(patch: Partial<Preferences>) { localStorage.setItem(KEY, JSON.stringify({ ...getPreferences(), ...patch })); window.dispatchEvent(new Event('zoompaper-preferences')); }
const subscribe = (fn: () => void) => { window.addEventListener('zoompaper-preferences', fn); window.addEventListener('storage', fn); return () => { window.removeEventListener('zoompaper-preferences', fn); window.removeEventListener('storage', fn); }; };
export const usePreferences = () => useSyncExternalStore(subscribe, getPreferences, getPreferences);
export function paperTitle(paper: {
    title: string;
    title_zh?: string | null;
}, place: 'library' | 'tab' | 'detail' | 'history', prefs = getPreferences()) {
    const choice = prefs[`${place}Language`];
    const language = choice === 'inherit' ? prefs.titleLanguage : choice;
    const original = displayPaperTitle(paper.title), zh = paper.title_zh?.trim();
    return !zh || language === 'original' ? original : language === 'both' ? `${zh} / ${original}` : zh;
}
export function missingMetadata(papers: Paper[]) { return papers.filter(p => !p.deleted_at && (!p.title_zh?.trim() || (!!p.abstract?.trim() && !p.abstract_zh?.trim()))); }
export function isViewPreferenceKey(key: string) { return /^zoompaper(?:\.preferences$|\.theme$|\.customTheme$|\.workspace$|[.:](?:page:|scale:|readerMode\.|qaTab\.|lastConv\.|librarySort$|libraryLayout$|paperInspectorWidth$|paperInspectorLanguage$|qaWidth$|qaCollapsed$|companion\.enabled$))/.test(key); }
export function exportViewPreferences() { const result: Record<string, string> = {}; for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (isViewPreferenceKey(key))
        result[key] = localStorage.getItem(key)!;
} return result; }
