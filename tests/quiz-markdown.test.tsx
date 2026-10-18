import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QuizPanel } from "@/components/QuizPanel";
import { quizGet, quizList, quizSubmitAnswer, type Quiz } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  quizList: vi.fn(),
  quizGet: vi.fn(),
  quizSubmitAnswer: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function makeQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: "quiz", paper_id: "paper", mode: "practice", status: "answering",
    config: { choice_count: 1, subjective_count: 0, difficulty: "基础", focus: "全面", sections: [] },
    questions: [{
      id: 1, qtype: "choice", question: String.raw`**选择**满足 \(x[0]=1\) 的公式。`,
      options: [String.raw`**正确项** $\frac{x[0]}{2}$`, String.raw`错误项 \[x[0]^2\]`],
      answer: "A", explanation: String.raw`由 $x[0]=1$ **可知**。`, section: "方法",
    }],
    answers: [], grading: [], created_at: 0, updated_at: 0,
    ...overrides,
  };
}

async function openQuiz(quiz: Quiz) {
  vi.mocked(quizList).mockResolvedValue([{
    id: quiz.id, mode: quiz.mode, status: quiz.status, difficulty: "基础", focus: "全面",
    question_count: quiz.questions.length, created_at: 0, updated_at: 0,
  }]);
  vi.mocked(quizGet).mockResolvedValue(quiz);
  const view = render(<QuizPanel paperId="paper" />);
  fireEvent.click(await screen.findByRole("button", { name: /基础 · 全面/ }));
  await screen.findByText("第 1 题");
  return view;
}

it.each(["practice", "exam"])("%s 模式渲染题干和选项中的 Markdown、行内及块公式，仍能选择答案", async (mode) => {
  const { container } = await openQuiz(makeQuiz({ mode }));
  expect(container.querySelectorAll(".katex").length).toBe(3);
  expect(container.querySelectorAll(".katex-display").length).toBe(1);
  expect(container.querySelector("strong")?.textContent).toBe("选择");
  const option = screen.getByText("正确项").closest("button")!;
  expect(within(option).getByText("正确项").tagName).toBe("STRONG");
  expect(option.querySelector("annotation")?.textContent).toBe(String.raw`\frac{x[0]}{2}`);
  fireEvent.click(option);
  expect(option.className).toContain("border-primary/60");
  if (mode === "practice") {
    vi.mocked(quizSubmitAnswer).mockResolvedValue({
      question_id: 1, correct: true, score: 1, max_score: 1,
      feedback: String.raw`**答对了**，$x[0]=1$。`, gaps: [],
    });
    fireEvent.click(screen.getByText("提交").closest("button")!);
    await waitFor(() => expect(quizSubmitAnswer).toHaveBeenCalledWith("quiz", 1, "A"));
    await screen.findByText("答对了");
    expect(container.querySelectorAll(".katex").length).toBe(4);
    expect((option as HTMLButtonElement).disabled).toBe(true);
  }
  expect(container.querySelectorAll(".katex-error").length).toBe(0);
});

it("结果页渲染选项和答案解析", async () => {
  const { container } = await openQuiz(makeQuiz({
    status: "done", answers: [{ question_id: 1, answer: "B" }],
    grading: [{ question_id: 1, correct: false, score: 0, max_score: 1, feedback: "", gaps: [] }],
  }));
  expect(container.querySelectorAll(".katex").length).toBe(4);
  expect(screen.getByText("可知").tagName).toBe("STRONG");
  expect(screen.getByText("正确项").closest("button")!.disabled).toBe(true);
});

it("主观题参考答案展开后渲染公式", async () => {
  const quiz = makeQuiz({ status: "done" });
  quiz.questions = [{ ...quiz.questions[0], qtype: "subjective", options: null, answer: String.raw`**推导**：\[x[0]=1\]` }];
  quiz.grading = [{ question_id: 1, score: 1, max_score: 1, feedback: "", gaps: [] }];
  const { container } = await openQuiz(quiz);
  expect(container.querySelectorAll(".katex").length).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "参考答案" }));
  expect(screen.getByText("推导").tagName).toBe("STRONG");
  expect(container.querySelectorAll(".katex").length).toBe(2);
});
