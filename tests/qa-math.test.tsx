import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QaChat } from "@/components/QaChat";
import { askQuestion, getConversation } from "@/lib/api";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage = () => {}; } }));

vi.mock("@/lib/api", () => ({
  getConversation: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({}),
  isWebSearchConfigured: vi.fn().mockReturnValue(false),
  askQuestion: vi.fn(),
}));

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

it("流式回答和最终回答都保留公式下标", async () => {
  const answer = "见 [3]，有 $a[0] + b[1]$。";
  let finish!: (value: Awaited<ReturnType<typeof askQuestion>>) => void;
  vi.mocked(askQuestion).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { container } = render(<QaChat />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "解释公式" } });
  fireEvent.click(screen.getByLabelText("发送消息"));
  await waitFor(() => expect(askQuestion).toHaveBeenCalled());
  const channel = vi.mocked(askQuestion).mock.calls.at(-1)![1]!.onEvent!;
  act(() => { channel.onmessage({ type: "content", text: "见 [3]，有 $a[0]" }); });
  act(() => { channel.onmessage({ type: "content", text: " + b[1]$。" }); });
  expect(container.querySelector("annotation")?.textContent).toBe("a[0] + b[1]");
  expect(container.querySelector("sup")?.textContent).toBe("[3]");

  await act(async () => { finish({ answer, conversation_id: "new", citations: [] }); });
  expect(container.querySelectorAll(".katex").length).toBe(1);
  expect(container.querySelector("annotation")?.textContent).toBe("a[0] + b[1]");
  expect(container.querySelectorAll(".katex-error").length).toBe(0);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

it.each([
  ["美元行内公式", "$a[0] + b[1]$", "a[0] + b[1]", false],
  ["反斜杠行内公式", String.raw`\(a[0] + b[1]\)`, "a[0] + b[1]", false],
  ["美元块公式", String.raw`$$\frac{a[0]}{b[1]} \tag{2}$$`, String.raw`\frac{a[0]}{b[1]} \tag{2}`, true],
  ["反斜杠块公式", String.raw`\[\frac{a[0]}{b[1]}\]`, String.raw`\frac{a[0]}{b[1]}`, true],
  ["裸公式", String.raw`\frac{a[0]}{b[1]} \tag{2}`, String.raw`\frac{a[0]}{b[1]} \tag{2}`, true],
])("问答历史中的%s保留下标并正确渲染", async (_name, formula, tex, display) => {
  vi.mocked(getConversation).mockResolvedValue({
    messages: JSON.stringify([{ role: "assistant", content: `见 [3]。\n\n${formula}\n\n代码：\`a[2]\`。` }]),
  } as Awaited<ReturnType<typeof getConversation>>);

  const { container } = render(<QaChat conversationId="history" />);
  await waitFor(() => expect(container.querySelectorAll(".katex").length).toBe(1));
  expect(container.querySelector("annotation")?.textContent).toBe(tex);
  expect(container.querySelectorAll(".katex-error").length).toBe(0);
  expect(container.querySelectorAll(".katex-display").length).toBe(display ? 1 : 0);
  expect(container.querySelector("sup")?.textContent).toBe("[3]");
  expect(container.querySelector("code")?.textContent).toBe("a[2]");
});

it("隐藏问答暂停流式展示，激活时补齐内容，后台完成不丢回答", async () => {
  let finish!: (value: Awaited<ReturnType<typeof askQuestion>>) => void;
  vi.mocked(askQuestion).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<QaChat />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "公式" } });
  fireEvent.click(screen.getByLabelText("发送消息"));
  const channel = vi.mocked(askQuestion).mock.calls.at(-1)![1]!.onEvent!;
  view.rerender(<QaChat active={false} />);
  act(() => { channel.onmessage({ type: "content", text: "$x[0]$" }); });
  expect(view.container.querySelector(".katex")).toBeNull();
  view.rerender(<QaChat active />);
  expect(view.container.querySelector("annotation")?.textContent).toBe("x[0]");
  view.rerender(<QaChat active={false} />);
  await act(async () => { finish({ answer: "$y[1]$", conversation_id: "saved", citations: [] }); });
  expect(view.container.querySelector("annotation")?.textContent).not.toBe("y[1]");
  view.rerender(<QaChat active />);
  expect(view.container.querySelector("annotation")?.textContent).toBe("y[1]");
});
