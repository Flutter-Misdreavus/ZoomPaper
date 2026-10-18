export const PDF_DOCUMENT_LIMIT = 3;
export const PDF_CANVAS_BUDGET = 192 * 1024 * 1024;

/** 最近访问顺序只管理 PDF 资源，绝不淘汰草稿和阅读器状态。 */
export function retainRecentPapers(recent: string[], id: string, limit = PDF_DOCUMENT_LIMIT): string[] {
  return [id, ...recent.filter(item => item !== id)].slice(0, limit);
}

interface CanvasEntry {
  bytes: number;
  /** 越大越优先回收；可见页返回 -1，软预算允许超出。 */
  priority: () => number;
  release: () => void;
  touched: number;
}
export class PdfCanvasCache {
  private entries = new Map<string, CanvasEntry>();
  private sequence = 0;
  constructor(readonly budget = PDF_CANVAS_BUDGET) {}
  register(key: string, bytes: number, priority: () => number, release: () => void) {
    this.entries.set(key, { bytes, priority, release, touched: ++this.sequence });
    this.trim();
  }
  forget(key: string) { this.entries.delete(key); }
  touch(key: string) { const entry = this.entries.get(key); if (entry) entry.touched = ++this.sequence; }
  get stats() { return { canvases: this.entries.size, bytes: [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }; }
  trim() {
    let bytes = this.stats.bytes;
    if (bytes <= this.budget) return;
    const candidates = [...this.entries].map(([key, entry]) => ({ key, entry, priority: entry.priority() }))
      .filter(candidate => candidate.priority >= 0)
      .sort((a, b) => b.priority - a.priority || a.entry.touched - b.entry.touched);
    for (const { key, entry } of candidates) {
      if (bytes <= this.budget) break;
      this.entries.delete(key);
      bytes -= entry.bytes;
      entry.release();
    }
  }
}

interface RenderJob { key: string; priority: number; run: (signal: AbortSignal) => Promise<void>; controller: AbortController; running: boolean; }
/** 所有 PDF 共用两条渲染通道；取消的运行任务结算后才释放通道。 */
export class PdfRenderQueue {
  private jobs = new Map<string, RenderJob>();
  private running = 0;
  private scheduled = false;
  constructor(readonly concurrency = 2) {}
  enqueue(key: string, priority: number, run: RenderJob["run"]) {
    const existing = this.jobs.get(key);
    if (existing) { existing.priority = priority; return; }
    this.jobs.set(key, { key, priority, run, controller: new AbortController(), running: false });
    this.schedule();
  }
  cancel(key: string) {
    const job = this.jobs.get(key);
    if (!job) return;
    job.controller.abort();
    if (!job.running) this.jobs.delete(key);
  }
  cancelOwner(owner: string) { for (const key of this.jobs.keys()) if (key.startsWith(`${owner}:`)) this.cancel(key); }
  get stats() { return { running: this.running, queued: [...this.jobs.values()].filter(job => !job.running).length }; }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    while (this.running < this.concurrency) {
      const next = [...this.jobs.values()].filter(job => !job.running && !job.controller.signal.aborted).sort((a, b) => a.priority - b.priority)[0];
      if (!next) return;
      next.running = true;
      this.running++;
      void Promise.resolve().then(() => next.controller.signal.aborted ? undefined : next.run(next.controller.signal)).catch(() => {}).finally(() => {
        this.jobs.delete(next.key);
        this.running--;
        this.schedule();
      });
    }
  }
}
export const pdfCanvasCache = new PdfCanvasCache();
export const pdfRenderQueue = new PdfRenderQueue();
let documents = 0;
export function trackPdfDocument() { documents++; let released = false; return () => { if (!released) { released = true; documents--; } }; }
export function getPdfResourceStats() { return { documents, ...pdfCanvasCache.stats, ...pdfRenderQueue.stats }; }
if (typeof window !== "undefined") Object.assign(window, { zoompaperPdfResources: { stats: getPdfResourceStats } });
