import { describe, expect, it } from "vitest";
import { PdfCanvasCache, PdfRenderQueue, retainRecentPapers } from "@/lib/pdfResources";

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("PDF 资源预算", () => {
  it("十篇论文访问后只保留最近三篇，切回会提升最近使用顺序", () => {
    let recent: string[] = [];
    for (let i = 0; i < 10; i++) recent = retainRecentPapers(recent, String(i));
    expect(recent).toEqual(["9", "8", "7"]);
    expect(retainRecentPapers(recent, "8")).toEqual(["8", "9", "7"]);
  });
  it("优先回收隐藏论文，再回收远页，可见页可以超出软预算", () => {
    const cache = new PdfCanvasCache(20);
    const released: string[] = [];
    cache.register("visible", 12, () => -1, () => released.push("visible"));
    cache.register("near", 4, () => 1, () => released.push("near"));
    cache.register("hidden", 4, () => 100, () => released.push("hidden"));
    cache.register("far", 8, () => 10, () => released.push("far"));
    expect(released).toEqual(["hidden", "far"]);
    expect(cache.stats.bytes).toBe(16);
    cache.register("large-visible", 24, () => -1, () => released.push("large-visible"));
    expect(released).toEqual(["hidden", "far", "near"]);
    expect(cache.stats.bytes).toBe(36);
    cache.forget("visible"); cache.forget("large-visible");
    expect(cache.stats).toEqual({ canvases: 0, bytes: 0 });
  });
  it("页面变为不可见后重新执行预算回收", () => {
    const cache = new PdfCanvasCache(10);
    let visible = true;
    let released = false;
    cache.register("page", 20, () => visible ? -1 : 2, () => { released = true; });
    expect(released).toBe(false);
    visible = false; cache.trim();
    expect(released).toBe(true);
  });
});

describe("PDF 全局渲染队列", () => {
  it("优先渲染可见页，并发不超过两页", async () => {
    const queue = new PdfRenderQueue(2);
    const started: number[] = [];
    const finish: Array<() => void> = [];
    for (const priority of [20, 0, 1]) queue.enqueue(`owner:${priority}`, priority, async () => {
      started.push(priority);
      await new Promise<void>(resolve => finish.push(resolve));
    });
    await settle();
    expect(started).toEqual([0, 1]);
    expect(queue.stats).toEqual({ running: 2, queued: 1 });
    finish[0](); await settle();
    expect(started).toEqual([0, 1, 20]);
    finish[1](); finish[2](); await settle();
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
  });
  it("取消旧任务后重新入队，旧任务结束不会删除新任务", async () => {
    const queue = new PdfRenderQueue(1);
    let oldSignal!: AbortSignal;
    let finish!: () => void;
    const started: string[] = [];
    queue.enqueue("a:old", 0, async signal => {
      oldSignal = signal; started.push("old");
      await new Promise<void>(resolve => { finish = resolve; });
    });
    await settle();
    queue.enqueue("a:queued", 1, async () => { started.push("cancelled"); });
    queue.cancelOwner("a");
    queue.enqueue("a:new", 0, async () => { started.push("new"); });
    expect(oldSignal.aborted).toBe(true);
    expect(queue.stats.running).toBe(1);
    finish(); await settle();
    expect(started).toEqual(["old", "new"]);
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
  });
});
