import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
vi.mock("@/lib/api", () => ({ listConversations: vi.fn().mockResolvedValue([]), deleteConversation: vi.fn() }));
vi.mock("@/components/QaChat", () => ({ QaChat: ({ onConversationCreated }: { onConversationCreated: (id: string) => void }) => {
  const [draft, setDraft] = useState("");
  return <><input aria-label="draft" value={draft} onChange={e => setDraft(e.target.value)} /><button onClick={() => onConversationCreated("saved-id")}>complete first reply</button></>;
} }));
import { QaPanel } from "@/components/QaPanel";
beforeEach(() => { localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps the next draft when the first response creates a server conversation and resets on explicit new chat", async () => {
  render(<QaPanel paperId="paper" />);
  const draft = await screen.findByLabelText("draft");
  fireEvent.change(draft, { target: { value: "next question" } });
  fireEvent.click(screen.getByText("complete first reply"));
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("next question");
  fireEvent.click(screen.getByLabelText("新对话"));
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
});

it("shows the expand icon only while the assistant is collapsed", () => {
  render(<QaPanel paperId="paper" />);
  expect(screen.queryByLabelText("展开对话")).toBeNull();
  fireEvent.click(screen.getByLabelText("收起对话"));
  expect(screen.getByLabelText("展开对话")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("展开对话"));
  expect(screen.queryByLabelText("展开对话")).toBeNull();
});
