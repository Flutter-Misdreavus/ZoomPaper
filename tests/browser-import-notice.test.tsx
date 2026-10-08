import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserImportNotice } from "@/components/BrowserImportNotice";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("closes a successful import notice after five seconds without filler copy", () => {
  const onClose = vi.fn();
  render(<BrowserImportNotice phase="done" title="Paper" message="" onClose={onClose} />);

  expect(screen.queryByText("现在可以开始阅读、翻译和提问。")).toBeNull();
  act(() => vi.advanceTimersByTime(4999));
  expect(onClose).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onClose).toHaveBeenCalledOnce();
});
