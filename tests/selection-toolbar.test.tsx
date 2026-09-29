import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { translateSelection } from "@/lib/api";
vi.mock("@/lib/api", () => ({ translateSelection: vi.fn() }));
const api = vi.mocked(translateSelection);
const props = {
  text: "vulnerability",
  x: 5000,
  y: 5000,
  onHighlight: vi.fn(),
  onNote: vi.fn(),
  onCopy: vi.fn(),
};
beforeEach(() => api.mockReset());
afterEach(cleanup);
describe("selection translation", () => {
  it("only requests on click and reuses the result when reopened", async () => {
    api.mockResolvedValue("漏洞");
    render(<SelectionToolbar {...props} />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("速译"));
    expect(await screen.findByText("漏洞")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("收起翻译"));
    fireEvent.click(screen.getByText("速译"));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("vulnerability", "");
  });
  it("passes nearby reading context without translating the whole paragraph", async () => {
    api.mockResolvedValue("漏洞");
    const paragraph = document.createElement("p");
    paragraph.textContent =
      "A vulnerability in software permits unauthorized access.";
    document.body.append(paragraph);
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 2);
    range.setEnd(paragraph.firstChild!, 15);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    render(<SelectionToolbar {...props} />);
    fireEvent.click(screen.getByText("速译"));
    expect(await screen.findByText("漏洞")).toBeTruthy();
    expect(api).toHaveBeenCalledWith("vulnerability", paragraph.textContent);
    window.getSelection()!.removeAllRanges();
    paragraph.remove();
  });
  it("ignores a stale response after selecting another word", async () => {
    let resolveOld!: (value: string) => void;
    api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { rerender } = render(<SelectionToolbar {...props} />);
    fireEvent.click(screen.getByText("速译"));
    rerender(<SelectionToolbar {...props} text="attention" />);
    api.mockResolvedValueOnce("注意力");
    fireEvent.click(screen.getByText("速译"));
    expect(await screen.findByText("注意力")).toBeTruthy();
    await act(async () => resolveOld("漏洞"));
    expect(screen.queryByText("漏洞")).toBeNull();
    expect(screen.getByText("注意力")).toBeTruthy();
  });
  it("shows failure and supports retry", async () => {
    api
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("漏洞");
    render(<SelectionToolbar {...props} />);
    fireEvent.click(screen.getByText("速译"));
    fireEvent.click(await screen.findByText("重试"));
    expect(await screen.findByText("漏洞")).toBeTruthy();
  });
  it("rejects oversized selections without an API request", () => {
    render(<SelectionToolbar {...props} text={"a".repeat(2001)} />);
    fireEvent.click(screen.getByText("速译"));
    expect(screen.getByText(/选中文字过长/)).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });
  it("clamps the floating toolbar to the viewport", () => {
    const { container } = render(<SelectionToolbar {...props} />);
    const panel = container.querySelector<HTMLElement>(
      "[data-selection-toolbar]",
    )!;
    expect(parseFloat(panel.style.left)).toBeLessThan(window.innerWidth);
    expect(parseFloat(panel.style.top)).toBeLessThan(window.innerHeight);
  });
});
