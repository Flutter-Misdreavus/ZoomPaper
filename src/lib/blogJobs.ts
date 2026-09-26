import { generateBlog } from "@/lib/api";

export type BlogJobSnapshot =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "completed"; markdown: string; completedAt: number }
  | { status: "failed"; error: string; completedAt: number };

type Listener = () => void;
type Runner = (paperId: string) => Promise<string>;

const IDLE: BlogJobSnapshot = Object.freeze({ status: "idle" });

/**
 * 应用级博客任务仓库。任务不依赖 Reader / BlogPanel 的生命周期，因此切换论文时
 * 仍会继续运行；按 paperId 隔离后，不同论文可以并行，同一论文不会重复提交。
 */
export class BlogJobStore {
  private readonly snapshots = new Map<string, BlogJobSnapshot>();
  private readonly promises = new Map<string, Promise<string>>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly run: Runner) {}

  getSnapshot(paperId: string): BlogJobSnapshot {
    return this.snapshots.get(paperId) ?? IDLE;
  }

  subscribe(paperId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(paperId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(paperId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(paperId);
    };
  }

  start(paperId: string): Promise<string> {
    const running = this.promises.get(paperId);
    if (running) return running;

    this.setSnapshot(paperId, { status: "running", startedAt: Date.now() });
    let task: Promise<string>;
    try {
      task = Promise.resolve(this.run(paperId));
    } catch (error) {
      task = Promise.reject(error);
    }
    const promise = task
      .then((markdown) => {
        this.promises.delete(paperId);
        this.setSnapshot(paperId, {
          status: "completed",
          markdown,
          completedAt: Date.now(),
        });
        return markdown;
      })
      .catch((error: unknown) => {
        this.promises.delete(paperId);
        this.setSnapshot(paperId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
        throw error;
      });

    // 主动保存 Promise，避免页面卸载后任务失去引用；catch 防止没有挂载页面时
    // rejected Promise 被浏览器报告为未处理异常，错误仍保留在 snapshot 中。
    this.promises.set(paperId, promise);
    void promise.catch(() => {});
    return promise;
  }

  private setSnapshot(paperId: string, snapshot: BlogJobSnapshot) {
    this.snapshots.set(paperId, snapshot);
    for (const listener of this.listeners.get(paperId) ?? []) listener();
  }
}

export const blogJobs = new BlogJobStore(generateBlog);
