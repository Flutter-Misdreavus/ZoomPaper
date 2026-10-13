import { expect, it, vi } from "vitest";
import { TranslationJobStore } from "./translationJobs";
function deferred() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((res) => { resolve = res; });
  return { promise, resolve };
}
it("continues and saves after the reader unsubscribes, with no duplicate on return", async () => {
  const response = deferred();
  const translate = vi.fn(() => response.promise);
  const save = vi.fn(async () => {});
  const store = new TranslationJobStore({ translate, save });
  const unsubscribe = store.subscribe("a", vi.fn());
  const first = store.start("a", "One paragraph.");
  unsubscribe();
  expect(store.start("a", "One paragraph.")).toBe(first);
  response.resolve("一个段落。");
  await first;
  expect(translate).toHaveBeenCalledOnce();
  expect(save).toHaveBeenLastCalledWith("a", [{ en: "One paragraph.", zh: "一个段落。" }]);
  expect(store.getSnapshot("a").status).toBe("completed");
});
it("isolates different papers and persists automatic repair without a mounted reader", async () => {
  const a = deferred(); const b = deferred();
  const save = vi.fn(async () => {});
  const store = new TranslationJobStore({ translate: vi.fn((text) => text === "A" ? a.promise : b.promise), save });
  const first = store.start("a", "A", [{ en: "A", zh: "" }], true);
  const second = store.start("b", "B");
  b.resolve("乙"); await second;
  expect(store.getSnapshot("a").status).toBe("running");
  a.resolve("甲"); await first;
  expect(save).toHaveBeenCalledWith("a", [{ en: "A", zh: "甲" }]);
  expect(store.getSnapshot("b").chunks).toEqual([{ en: "B", zh: "乙" }]);
});
it("checkpoints before a later error and resumes without retranslating completed chunks", async () => {
  const first = "A".repeat(2600); const second = "B".repeat(2600);
  let failing = true;
  const translate = vi.fn(async (text: string) => {
    if (text === second && failing) throw new Error("network");
    return text === first ? "甲" : "乙";
  });
  const save = vi.fn(async () => {});
  const store = new TranslationJobStore({ translate, save });
  await expect(store.start("a", `${first}\n\n${second}`)).rejects.toThrow("network");
  const partial = store.getSnapshot("a").chunks!;
  expect(partial).toEqual([{ en: first, zh: "甲" }, { en: second, zh: "" }]);
  expect(save).toHaveBeenCalledWith("a", partial);
  failing = false;
  await store.start("a", `${first}\n\n${second}`, partial);
  expect(translate.mock.calls.filter(([text]) => text === first)).toHaveLength(1);
  expect(store.getSnapshot("a").status).toBe("completed");
});
