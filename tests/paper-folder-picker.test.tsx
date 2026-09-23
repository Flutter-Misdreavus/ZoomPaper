import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperFolderPicker } from "@/components/library/PaperFolderPicker";
import type { Folder, Paper } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  addPapersToFolder: vi.fn(),
  removePapersFromFolder: vi.fn(),
}));

import { addPapersToFolder } from "@/lib/api";

const folders: Folder[] = [
  { id: "folder-a", name: "方法", parent_id: null, color: "blue", tags: [], created_at: 1 },
  { id: "folder-b", name: "实验", parent_id: null, color: "green", tags: [], created_at: 2 },
];

function paper(folderIds: string[]): Paper {
  return {
    id: "paper-1",
    title: "Paper",
    authors: null,
    abstract: null,
    pdf_path: "/paper.pdf",
    md_path: "/paper.md",
    blog_md_path: null,
    created_at: 1,
    last_read_at: null,
    reading_status: "unread",
    parse_status: "ready",
    starred: false,
    finished_at: null,
    total_read_seconds: 0,
    folder_ids: folderIds,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PaperFolderPicker", () => {
  it("shows the new check after adding a paper when several folders exist", async () => {
    vi.mocked(addPapersToFolder).mockResolvedValue(1);
    let currentPaper = paper(["folder-a"]);
    let rerender!: ReturnType<typeof render>["rerender"];
    let finishRefresh!: () => void;
    const onChanged = vi.fn(() => new Promise<void>((resolve) => {
      finishRefresh = () => {
        currentPaper = paper(["folder-a", "folder-b"]);
        rerender(view());
        resolve();
      };
    }));
    const view = () => (
      <PaperFolderPicker
        open
        onOpenChange={vi.fn()}
        papers={[currentPaper]}
        folders={folders}
        onChanged={onChanged}
        onError={vi.fn()}
      />
    );

    ({ rerender } = render(view()));
    const first = screen.getByRole("checkbox", { name: /方法/ });
    const second = screen.getByRole("checkbox", { name: /实验/ });
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(second.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(second);

    await waitFor(() => expect(addPapersToFolder).toHaveBeenCalledOnce());
    expect(second.hasAttribute("disabled")).toBe(true);
    finishRefresh();
    await waitFor(() => expect(second.getAttribute("aria-checked")).toBe("true"));
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(addPapersToFolder).toHaveBeenCalledWith(["paper-1"], "folder-b");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
