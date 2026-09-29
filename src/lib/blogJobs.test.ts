import { describe, expect, it, vi } from "vitest";
import { BlogJobStore } from "./blogJobs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BlogJobStore", () => {
  it("keeps a paper job alive without subscribers and exposes its result later", async () => {
    const task = deferred<string>();
    const run = vi.fn(() => task.promise);
    const store = new BlogJobStore(run);
    const unsubscribe = store.subscribe("paper-a", vi.fn());

    const promise = store.start("paper-a");
    unsubscribe();
    expect(store.getSnapshot("paper-a").status).toBe("running");

    task.resolve("# 完成的博客");
    await promise;
    expect(store.getSnapshot("paper-a")).toMatchObject({
      status: "completed",
      markdown: "# 完成的博客",
    });
  });

  it("deduplicates the same paper while allowing different papers in parallel", async () => {
    const tasks = new Map([
      ["paper-a", deferred<string>()],
      ["paper-b", deferred<string>()],
    ]);
    const run = vi.fn((paperId: string) => tasks.get(paperId)!.promise);
    const store = new BlogJobStore(run);

    const first = store.start("paper-a");
    const duplicate = store.start("paper-a");
    const other = store.start("paper-b");

    expect(duplicate).toBe(first);
    expect(run).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot("paper-b").status).toBe("running");

    tasks.get("paper-a")!.resolve("A");
    tasks.get("paper-b")!.resolve("B");
    await expect(first).resolves.toBe("A");
    await expect(other).resolves.toBe("B");
  });

  it("records failures and permits retrying the paper", async () => {
    const run = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("网络失败"))
      .mockResolvedValueOnce("重试成功");
    const store = new BlogJobStore(run);

    await expect(store.start("paper-a")).rejects.toThrow("网络失败");
    expect(store.getSnapshot("paper-a")).toMatchObject({
      status: "failed",
      error: "网络失败",
    });

    await expect(store.start("paper-a")).resolves.toBe("重试成功");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
