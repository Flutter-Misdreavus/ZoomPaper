import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpPage } from "@/pages/HelpPage";

vi.mock("@/lib/api", () => ({
  askAppHelp: vi.fn(),
}));

afterEach(cleanup);

describe("HelpPage", () => {
  it("shows the exact operation steps for a selected feature", () => {
    render(<HelpPage />);

    fireEvent.click(screen.getByRole("button", { name: "添加到文件夹" }));

    expect(screen.getByRole("heading", { name: "添加到文件夹" })).toBeTruthy();
    expect(screen.getByText("右键论文，或长按论文进入多选。")).toBeTruthy();
    expect(screen.getByText("点击文件夹图标。")).toBeTruthy();
    expect(screen.getByText("点击“完成”应用更改。")).toBeTruthy();
  });

  it("switches between complete feature categories", () => {
    render(<HelpPage />);

    fireEvent.click(screen.getByRole("button", { name: "翻译与学习" }));

    expect(screen.getByRole("button", { name: "AI 全文翻译" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI 博客" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "费曼学习" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "论文测验" })).toBeTruthy();
  });
});
