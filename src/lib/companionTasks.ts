import { useEffect, useMemo, useRef, useState } from 'react';
import { getPaper, getPaperMd, getTranslation, type BackgroundJob } from './api';
import { blogJobs } from './blogJobs';
import { translationJobs } from './translationJobs';
export type CompanionTask = Omit<BackgroundJob, 'kind'> & { kind: BackgroundJob['kind'] | 'blog' | 'full_translation'; local?: boolean };
const KEY = 'zoompaper.companion.tasks';
export function restoreCompanionTasks(raw: string | null): CompanionTask[] {
  try {
    const values = JSON.parse(raw ?? '[]');
    if (!Array.isArray(values)) return [];
    return values.filter(task => task && typeof task.paper_id === 'string' && task.paper_id.length > 0 && ['blog', 'full_translation'].includes(task.kind) && ['running', 'failed'].includes(task.status)).map(task => ({ ...task, id: `local:${task.kind}:${task.paper_id}`, title: typeof task.title === 'string' ? task.title : '论文', created_at: Number.isFinite(task.created_at) ? task.created_at : Date.now()/1000, updated_at: Number.isFinite(task.updated_at) ? task.updated_at : Date.now()/1000, local: true, status: 'failed', error: task.status === 'running' ? '上次退出时任务未完成，点击重试继续。' : task.error }));
  } catch { return []; }
}
export async function retryCompanionTask(task: Pick<CompanionTask, 'paper_id' | 'kind'>) {
  if (task.kind === 'blog') { await blogJobs.start(task.paper_id); return; }
  if (task.kind !== 'full_translation') throw new Error('未知任务');
  const [markdown, cached] = await Promise.all([getPaperMd(task.paper_id), getTranslation(task.paper_id)]);
  await translationJobs.start(task.paper_id, markdown, cached);
}
export function useCompanionTasks() {
  const [revision, setRevision] = useState(0);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const alive = useRef(true);
  const restored = useRef(restoreCompanionTasks(localStorage.getItem(KEY)));
  const dates = useRef(new Map<string, { status: string; created: number; updated: number }>());
  const requested = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    const update = () => setRevision(value => value + 1);
    const stopBlog = blogJobs.subscribeAll(update), stopTranslation = translationJobs.subscribeAll(update);
    update(); return () => { alive.current = false; stopBlog(); stopTranslation(); };
  }, []);
  const tasks = useMemo(() => {
    const result = new Map(restored.current.map(task => [task.id, task]));
    const records = [
      ...blogJobs.getEntries().map(([id, snapshot]) => ({ id, kind: 'blog' as const, snapshot })),
      ...translationJobs.getEntries().map(([id, snapshot]) => ({ id, kind: 'full_translation' as const, snapshot })),
    ];
    for (const { id: paperId, kind, snapshot } of records) {
      if (snapshot.status === 'idle') continue;
      const id = `local:${kind}:${paperId}`;
      const status = snapshot.status === 'completed' ? 'done' : snapshot.status;
      const previous = dates.current.get(id);
      const now = Date.now() / 1000;
      const date = { status, created: previous?.created ?? now, updated: previous?.status === status ? previous.updated : now };
      dates.current.set(id, date);
      const translation = kind === 'full_translation' ? translationJobs.getSnapshot(paperId) : null;
      result.set(id, { id, paper_id: paperId, title: titles[paperId] ?? '论文', kind, local: true, status,
        stage: translation?.stage ?? '', completed_pages: translation?.progress?.done ?? null, total_pages: translation?.progress?.total ?? null,
        error: snapshot.status === 'failed' ? snapshot.error ?? null : null, created_at: date.created, updated_at: date.updated });
    }
    return [...result.values()].map(task => ({ ...task, title: titles[task.paper_id] ?? task.title }));
  }, [revision, titles]);
  useEffect(() => {
    for (const task of tasks) {
      if (requested.current.has(task.paper_id)) continue;
      requested.current.add(task.paper_id);
      void getPaper(task.paper_id).then(paper => { if (alive.current) setTitles(current => ({ ...current, [paper.id]: paper.title })); }).catch(() => { requested.current.delete(task.paper_id); });
    }
    try { localStorage.setItem(KEY, JSON.stringify(tasks.filter(task => ['running', 'failed'].includes(task.status)))); } catch { /* Optional restoration metadata. */ }
  }, [tasks]);
  return tasks;
}
