import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BlogJobStore } from '@/lib/blogJobs';
import { TranslationJobStore } from '@/lib/translationJobs';
import { restoreCompanionTasks, retryCompanionTask, useCompanionTasks } from '@/lib/companionTasks';
const mocks = vi.hoisted(() => ({ entries: [] as any[], listeners: new Set<() => void>(), blog: vi.fn(), translation: vi.fn() }));
vi.mock('@/lib/api', () => ({ getPaper: async (id:string) => ({id,title:'Research paper'}), getPaperMd: async () => '# Text', getTranslation: async () => [{en:'# Text',zh:'正文'}], generateBlog: vi.fn(), saveTranslation: vi.fn(), translateChunk: vi.fn() }));
vi.mock('@/lib/blogJobs', async importOriginal => ({...await importOriginal<any>(), blogJobs:{getEntries:()=>mocks.entries,subscribeAll:(fn:()=>void)=>{mocks.listeners.add(fn);return()=>mocks.listeners.delete(fn);},start:mocks.blog}}));
vi.mock('@/lib/translationJobs', async importOriginal => ({...await importOriginal<any>(), translationJobs:{getEntries:()=>[],subscribeAll:()=>()=>{},start:mocks.translation}}));
afterEach(()=>{cleanup();localStorage.clear();mocks.entries=[];vi.clearAllMocks();});
it('keeps notifying the companion after a blog reader unsubscribes', async () => {
  let finish!: (text:string)=>void;
  const runner = vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
  const store = new BlogJobStore(runner), all = vi.fn(), reader=vi.fn();
  store.subscribeAll(all); const stop=store.subscribe('p',reader);
  const first=store.start('p'); expect(store.start('p')).toBe(first);
  stop(); finish('blog'); await first;
  expect(runner).toHaveBeenCalledOnce(); expect(reader).toHaveBeenCalledOnce();
  expect(all).toHaveBeenCalledTimes(2); expect(store.getEntries()[0][1].status).toBe('completed');
});
it('tracks translation completion independently of reader subscriptions', async () => {
  const store = new TranslationJobStore({translate:async()=> '译文',save:vi.fn().mockResolvedValue(undefined)});
  const all=vi.fn();store.subscribeAll(all); const stop=store.subscribe('p',vi.fn());
  const task=store.start('p','# Text');stop();await task;
  expect(store.getSnapshot('p').status).toBe('completed');expect(all.mock.calls.length).toBeGreaterThan(2);
});
it('restores interrupted jobs as retryable failures and discards invalid metadata', () => {
  const restored=restoreCompanionTasks(JSON.stringify([{paper_id:'p',kind:'full_translation',status:'running'}, {kind:'blog',status:'running'}, {paper_id:'p',kind:'blog',status:'done'}]));
  expect(restored).toHaveLength(1);expect(restored[0].id).toBe('local:full_translation:p');
  expect(restored[0].status).toBe('failed');expect(restored[0].error).toContain('重试');
});
it('publishes title and task completion and persists only unfinished metadata', async () => {
  mocks.entries=[['p',{status:'running',startedAt:1}]];
  const hook=renderHook(()=>useCompanionTasks());
  await waitFor(()=>expect(hook.result.current[0].title).toBe('Research paper'));
  expect(JSON.parse(localStorage.getItem('zoompaper.companion.tasks')!)[0].kind).toBe('blog');
  act(()=>{mocks.entries=[['p',{status:'completed',markdown:'private content',completedAt:2}]];for(const listener of mocks.listeners)listener();});
  expect(hook.result.current[0].status).toBe('done');
  expect(localStorage.getItem('zoompaper.companion.tasks')).toBe('[]');
});
it('retries translation with saved chunks instead of starting from scratch', async () => {
  await retryCompanionTask({paper_id:'p',kind:'full_translation'});
  expect(mocks.translation).toHaveBeenCalledWith('p','# Text',[{en:'# Text',zh:'正文'}]);
});
