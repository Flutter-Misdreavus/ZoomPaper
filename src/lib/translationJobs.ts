import { saveTranslation, translateChunk, type TranslationChunk } from "./api";
import { chunkMarkdown, fillMissingChunks, splitReferences } from "./translate";
export interface TranslationJob {
  status: "idle" | "running" | "completed" | "failed";
  stage?: "translate" | "repair";
  chunks?: TranslationChunk[];
  progress?: { done: number; total: number };
  stats?: { filled: number; failed: number };
  error?: string;
}
const idle: TranslationJob = Object.freeze({ status: "idle" });
interface Dependencies {
  translate: (text: string) => Promise<string>;
  save: (id: string, chunks: TranslationChunk[]) => Promise<void>;
}
/** Application-owned tasks: removing a reader only removes its subscription. */
export class TranslationJobStore {
  private snapshots = new Map<string, TranslationJob>();
  private tasks = new Map<string, Promise<TranslationChunk[]>>();
  private globalListeners = new Set<() => void>();
  getEntries() { return [...this.snapshots.entries()]; }
  subscribeAll(listener: () => void) { this.globalListeners.add(listener); return () => { this.globalListeners.delete(listener); }; }
  private listeners = new Map<string, Set<() => void>>();
  constructor(private deps: Dependencies) {}
  getSnapshot(id: string) { return this.snapshots.get(id) ?? idle; }
  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private publish(id: string, job: TranslationJob) {
    this.snapshots.set(id, job);
    for (const listener of this.globalListeners) listener();
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
  start(id: string, markdown: string, cached: TranslationChunk[] | null = null, repairOnly = false) {
    const existing = this.tasks.get(id); if (existing) return existing;
    this.publish(id, { status: "running", stage: repairOnly ? "repair" : "translate", chunks: cached ?? undefined });
    const task = Promise.resolve().then(async () => {
      let chunks = cached ?? [];
      if (!repairOnly) {
        const parts = chunkMarkdown(splitReferences(markdown).body);
        const saved = new Map((cached ?? []).map((chunk) => [chunk.en, chunk.zh]));
        chunks = parts.map((en) => ({ en, zh: saved.get(en) ?? "" }));
        for (let i = 0; i < parts.length; i++) {
          if (!chunks[i].zh.trim()) {
            const zh = await this.deps.translate(parts[i]);
            if (!zh.trim()) throw new Error("模型返回了空译文，请重试");
            chunks = chunks.map((chunk, index) => index === i ? { ...chunk, zh } : chunk);
            // Checkpoint every completed chunk, independently of any mounted page.
            await this.deps.save(id, chunks);
          }
          this.publish(id, { status: "running", stage: "translate", chunks, progress: { done: i + 1, total: parts.length } });
        }
      }
      this.publish(id, { status: "running", stage: "repair", chunks });
      const result = await fillMissingChunks(chunks, this.deps.translate);
      await this.deps.save(id, result.chunks);
      this.publish(id, { status: "completed", chunks: result.chunks, stats: { filled: result.filled, failed: result.failed } });
      return result.chunks;
    }).catch((error: unknown) => {
      this.publish(id, { ...this.getSnapshot(id), status: "failed", error: String(error) });
      throw error;
    }).finally(() => { this.tasks.delete(id); });
    this.tasks.set(id, task);
    void task.catch(() => {});
    return task;
  }
}
export const translationJobs = new TranslationJobStore({ translate: translateChunk, save: saveTranslation });
