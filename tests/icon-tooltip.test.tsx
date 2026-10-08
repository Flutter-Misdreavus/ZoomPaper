import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IconTooltip } from "@/components/ui/icon-tooltip";

afterEach(cleanup);

describe("IconTooltip", () => {
  it("explains an icon on keyboard focus while keeping its action clickable", async () => {
    const onClick = vi.fn();
    render(<IconTooltip label="标记已读"><button type="button" aria-label="标记已读" onClick={onClick}>✓</button></IconTooltip>);

    const button = screen.getByRole("button", { name: "标记已读" });
    fireEvent.focus(button);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("标记已读"), { timeout: 1500 });

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("can explain a disabled icon", async () => {
    render(<IconTooltip label="每次请选择一篇论文导出笔记"><button type="button" aria-label="导出阅读笔记" disabled>↓</button></IconTooltip>);
    const button = screen.getByRole("button", { name: "导出阅读笔记" });
    fireEvent.focus(button.parentElement!);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("每次请选择一篇论文导出笔记"), { timeout: 1500 });
  });
});
