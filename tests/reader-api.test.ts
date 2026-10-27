import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { getPaper, listConversationSummaries, touchPaper, type Paper } from "@/lib/api";
it("合并同一论文的并发读取，完成后允许重新读取最新数据", async () => {
  const call = vi.mocked(invoke); call.mockReset();
  let finish!: (paper: Paper) => void;
  call.mockImplementationOnce(() => new Promise<Paper>(resolve => { finish = resolve; }));
  const first = getPaper("paper"); const second = getPaper("paper");
  expect(first).toBe(second);
  expect(call).toHaveBeenCalledTimes(1);
  finish({ id:"paper" } as Paper); await first;
  call.mockResolvedValueOnce({ id:"paper", title:"updated" });
  expect((await getPaper("paper")).title).toBe("updated");
  expect(call).toHaveBeenCalledTimes(2);
});
it("访问记录与本篇会话摘要使用轻量命令", async () => {
  const call = vi.mocked(invoke); call.mockReset(); call.mockResolvedValue(undefined);
  await touchPaper("paper");
  expect(call).toHaveBeenLastCalledWith("touch_paper", {paperId:"paper"});
  await listConversationSummaries("paper");
  expect(call).toHaveBeenLastCalledWith("list_conversation_summaries", {paperId:"paper"});
});
