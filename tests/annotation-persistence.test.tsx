import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { saveAnnotations } from "@/lib/api";
import { loadTextHighlights } from "@/lib/annotations";
const call = vi.mocked(invoke);
beforeEach(() => call.mockReset());
it("serializes writes per document so an older save cannot replace the newer edit", async () => {
  let release!: () => void;
  call.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValueOnce(undefined);
  const old = saveAnnotations("paper", "old");
  const latest = saveAnnotations("paper", "latest");
  await Promise.resolve(); await Promise.resolve();
  expect(call).toHaveBeenCalledTimes(1);
  release(); await old; await latest;
  expect(call).toHaveBeenLastCalledWith("save_annotations", { paperId: "paper", data: "latest", kind: null });
});
it("allows a later save to recover after a rejected write", async () => {
  call.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
  await expect(saveAnnotations("paper", "old")).rejects.toThrow("disk full");
  await expect(saveAnnotations("paper", "new")).resolves.toBeUndefined();
});
it("does not treat a damaged annotation file or IO error as an empty notebook", async () => {
  call.mockResolvedValueOnce("{broken");
  await expect(loadTextHighlights("p", "blog")).rejects.toThrow();
  call.mockRejectedValueOnce(new Error("unreadable"));
  await expect(loadTextHighlights("p", "blog")).rejects.toThrow("unreadable");
  call.mockResolvedValueOnce(null);
  await expect(loadTextHighlights("p", "blog")).resolves.toEqual([]);
});
