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
    expect(screen.getByRole("button", { name: "论文测验" })).toBeTruthy();
  });

  it("documents Zotero import and补挂 PDF", () => {
    render(<HelpPage />);

    fireEvent.click(screen.getByRole("button", { name: "从 Zotero 导入" }));
    expect(screen.getByRole("heading", { name: "从 Zotero 导入" })).toBeTruthy();
    expect(screen.getByText("在论文库点击“从 Zotero 导入题录”，选择题录文件。")).toBeTruthy();
    expect(screen.getByText("确认导入。合并到已有论文时会保留原 PDF、标注、文件夹、会话和测验，只补充缺失元数据。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "补挂 PDF" }));
    expect(screen.getByRole("heading", { name: "补挂 PDF" })).toBeTruthy();
    expect(screen.getByText("在详情中点击“补挂 PDF”，选择本地 PDF 文件。")).toBeTruthy();
  });
});
