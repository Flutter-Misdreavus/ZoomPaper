import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLongPressSelection } from "@/hooks/useLongPressSelection";

function Row({ onSelect, onOpen }: { onSelect: () => void; onOpen: () => void }) {
  const hold = useLongPressSelection(onSelect);
  return <div role="row" {...hold.bind("paper")}
    onClick={() => { if (!hold.consumeClick("paper")) onOpen(); }}>
    <span>Paper</span><button type="button">More</button>
  </div>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("enters selection after a hold and does not also open the paper", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<Row onSelect={onSelect} onOpen={onOpen} />);
  const row = screen.getByRole("row");
  fireEvent.pointerDown(row, { button: 0, isPrimary: true, clientX: 20, clientY: 20 });
  act(() => vi.advanceTimersByTime(500));
  fireEvent.pointerUp(row);
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
});

it("does not select during scroll, short click, or a button press", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<Row onSelect={onSelect} onOpen={onOpen} />);
  const row = screen.getByRole("row");
  fireEvent.pointerDown(row, { button: 0, isPrimary: true, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(row, { clientX: 20, clientY: 40 });
  act(() => vi.advanceTimersByTime(600));
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0, isPrimary: true });
  act(() => vi.advanceTimersByTime(600));
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.pointerDown(row, { button: 0, isPrimary: true });
  fireEvent.pointerUp(row);
  act(() => vi.advanceTimersByTime(600));
  fireEvent.click(row);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onOpen).toHaveBeenCalledOnce();
});
