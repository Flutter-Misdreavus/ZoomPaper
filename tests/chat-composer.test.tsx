import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "@/components/ChatComposer";
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = {
  value: "你好",
  onChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  sending: false,
  placeholder: "聊聊这篇论文…",
  controls: <span>深度</span>,
};
it("sends with Enter, but preserves Shift+Enter and Chinese composition", () => {
  const send = vi.fn();
  render(<ChatComposer {...props} onSend={send} />);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("grows for multiline text and caps its height with scrolling", () => {
  const { rerender } = render(<ChatComposer {...props} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 240,
  });
  rerender(<ChatComposer {...props} value={"line\n".repeat(20)} />);
  expect(input.style.height).toBe("180px");
  expect(input.style.overflowY).toBe("auto");
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 24,
  });
  rerender(<ChatComposer {...props} value="" />);
  expect(input.style.height).toBe("48px");
  expect(input.style.overflowY).toBe("hidden");
});
it("allows composing the next message while generating but only exposes stop", () => {
  const send = vi.fn(),
    stop = vi.fn();
  render(<ChatComposer {...props} sending onSend={send} onStop={stop} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("停止生成"));
  expect(stop).toHaveBeenCalledOnce();
});
it("disables sending whitespace and keeps the composer free of persistent help text", () => {
  render(<ChatComposer {...props} value="  " />);
  expect(
    (screen.getByLabelText("发送消息") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByText("Enter 发送 · Shift + Enter 换行")).toBeNull();
  expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe(
    "聊聊这篇论文…",
  );
});
