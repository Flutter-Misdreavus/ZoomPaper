import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReferenceImportDialog } from "@/components/library/ReferenceImportDialog";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  commit: vi.fn(),
  enrich: vi.fn(),
  open: vi.fn(),
  imported: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  prepareReferenceImport: mocks.prepare,
  commitReferenceImport: mocks.commit,
  enrichReferenceImport: mocks.enrich,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage = () => {}; } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const preview = {
  import_id: "import-1",
  format: "bibtex" as const,
  total: 1,
  errors: [],
  items: [
    {
      id: "ref-0",
      record: {
        key: "smith2020",
        item_type: "journalArticle",
        title: "Paper One",
        authors: ["Smith, John"],
        year: 2020,
        venue: "TestConf",
        doi: "10.1/abc",
        url: null,
        abstract_text: null,
        attachment_paths: [],
      },
      attachment: {
        path: "/tmp/paper.pdf",
        file_name: "paper.pdf",
        size: 10,
        matched_by: "auto",
      },
      attachment_candidates: [],
      existing: null,
      batch_duplicates: [],
      default_action: "new" as const,
      issue: null,
      enrichment_error: null,
    },
  ],
};

it("previews Zotero records and commits selected decisions", async () => {
  mocks.open.mockResolvedValueOnce("/tmp/refs.bib");
  mocks.prepare.mockResolvedValueOnce(preview);
  mocks.commit.mockResolvedValueOnce({
    created: 1,
    merged: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
    failures: [],
    paper_ids: ["new-paper"],
  });

  render(
    <ReferenceImportDialog
      open
      folders={[]}
      onClose={mocks.close}
      onImported={mocks.imported}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Zotero 题录文件") as HTMLInputElement).value).toBe(
      "/tmp/refs.bib",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "解析并预览" }));
  await screen.findByText("Paper One");
  expect(screen.getByText("附件：paper.pdf")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() =>
    expect(mocks.commit).toHaveBeenCalledWith(
      "import-1",
      [expect.objectContaining({ item_id: "ref-0", action: "new" })],
      null,
      false,
      true,
    ),
  );
  await screen.findByText("导入完成");
  expect(mocks.imported).toHaveBeenCalledWith(
    expect.objectContaining({ created: 1, paper_ids: ["new-paper"] }),
  );
});
