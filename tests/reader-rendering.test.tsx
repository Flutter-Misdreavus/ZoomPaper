import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Reader } from "@/pages/Reader";
import { MarkdownView } from "@/components/MarkdownView";
import { applyMarks } from "@/lib/textAnnotate";
import { useActiveSnapshot } from "@/hooks/useActiveSnapshot";
import { getPaper, addReadingTime, touchPaper } from "@/lib/api";
const counters = vi.hoisted(() => ({ pdf: vi.fn(), blog: vi.fn(), translate: vi.fn() }));
vi.mock("@/lib/api", () => ({
  getPaper: vi.fn(), refreshPaperPublication: vi.fn().mockRejectedValue("offline"),
  touchPaper: vi.fn().mockResolvedValue(undefined), addReadingTime: vi.fn().mockResolvedValue(undefined),
  setPaperStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/PdfViewer", () => ({ PdfViewer: vi.fn(() => { counters.pdf(); return <div>PDF</div>; }) }));
vi.mock("@/components/BlogPanel", () => ({ BlogPanel: () => { counters.blog(); return <div>blog content</div>; } }));
vi.mock("@/components/TranslatePanel", () => ({ TranslatePanel: () => { counters.translate(); return <div>translation content</div>; } }));
vi.mock("@/components/QaPanel", () => ({ QaPanel: () => <input aria-label="draft" /> }));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.mocked(getPaper).mockResolvedValue({ id: "paper", title: "Paper", parse_status: "ready", total_read_seconds: 0, reading_status: "reading", pdf_path: "paper.pdf" } as Awaited<ReturnType<typeof getPaper>>);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("阅读计时不重绘正文，未访问的博客/翻译不初始化，隐藏刷新延后到激活", async () => {
  vi.useFakeTimers();
  const view = render(<Reader paperId="paper" active onBack={() => {}} refreshSignal={0} />);
  await act(async () => {});
  expect(counters.blog).not.toHaveBeenCalled();
  expect(counters.translate).not.toHaveBeenCalled();
  const before = counters.pdf.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(30000); });
  expect(counters.pdf).toHaveBeenCalledTimes(before);
  expect(addReadingTime).toHaveBeenCalledWith("paper", 30);
  expect(getPaper).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "keep" } });
  view.rerender(<Reader paperId="paper" active={false} onBack={() => {}} refreshSignal={1} />);
  expect(getPaper).toHaveBeenCalledTimes(1);
  view.rerender(<Reader paperId="paper" active onBack={() => {}} refreshSignal={1} />);
  await act(async () => {});
  expect(getPaper).toHaveBeenCalledTimes(2);
  expect(touchPaper).toHaveBeenCalledTimes(2);
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("keep");
});

it("静态 Markdown 在父组件刷新时保留渲染 DOM，内容变化仍会更新", () => {
  const view = render(<MarkdownView markdown="公式 $x[0]$" />);
  const formula = view.container.querySelector(".katex");
  view.rerender(<MarkdownView markdown="公式 $x[0]$" />);
  expect(view.container.querySelector(".katex")).toBe(formula);
  view.rerender(<MarkdownView markdown="公式 $y[1]$" />);
  expect(view.container.querySelector("annotation")?.textContent).toBe("y[1]");
});

it("隐藏面板不订阅任务，重新激活直接取得最新快照", () => {
  let snapshot = 0;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function Panel({ active }: { active: boolean }) {
    const value = useActiveSnapshot(active, subscribe, () => snapshot);
    return <span>{value}</span>;
  }
  const view = render(<Panel active />);
  expect(listeners.size).toBe(1);
  view.rerender(<Panel active={false} />);
  expect(listeners.size).toBe(0);
  snapshot = 4;
  expect(view.container.textContent).toBe("0");
  view.rerender(<Panel active />);
  expect(view.container.textContent).toBe("4");
  expect(listeners.size).toBe(1);
});

it("Markdown 内容更新时安全替换已被高亮包裹的 DOM", () => {
  const view = render(<MarkdownView markdown="one two three" />);
  applyMarks(view.container, [{ id:"highlight", docKey:"body", label:"正文", start:4, end:7, text:"two", color:"yellow", note:null, created_at:0 }]);
  expect(view.container.querySelector("mark")?.textContent).toBe("two");
  view.rerender(<MarkdownView markdown="one **changed** three" />);
  expect(view.container.textContent).toBe("one changed three");
  expect(view.container.querySelector("mark")).toBeNull();
});
