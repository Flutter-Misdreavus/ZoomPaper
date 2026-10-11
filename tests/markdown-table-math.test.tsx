import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownView } from "@/components/MarkdownView";

afterEach(cleanup);

/** MinerU 把表格输出成单行原始 HTML，公式就藏在这些 <td> 里——正是本用例覆盖的场景。 */
const MINERU_TABLE = `<table><tr><td>Method</td><td>Unified Memory-update Rule</td></tr><tr><td>Linear Attn [53]</td><td> $S_t = S_{t-1} + k_t v_t^\\top$ </td></tr><tr><td>DeltaNet [123]</td><td>State-update:  $S_t = S_{t-1}(I - \\beta_t k_t k_t^\\top) + \\beta_t k_t v_t^\\top$ </td></tr><tr><td colspan="2">Gradient-State Recurrence</td></tr><tr><td>Yaad (Huber) [5]</td><td> $S_t = a_t S_{t-1} - \\eta_t \\begin{cases} \\nabla_s \\ell_2, &amp; \\|S(k_t) - v_t\\| \\leq \\delta_t \\\\ \\delta_t \\nabla_s \\ell_1, &amp; \\text{otherwise} \\end{cases}$ </td></tr></table>`;

function renderMarkdown(markdown: string) {
  return render(<MarkdownView markdown={markdown} />).container;
}

describe("MarkdownView 表格公式渲染", () => {
  it("渲染原始 HTML 表格单元格里的行内公式（不再显示 $...$ 字面文本）", () => {
    const container = renderMarkdown(MINERU_TABLE);

    expect(container.textContent).not.toContain("$S_t");
    expect(container.querySelectorAll(".katex").length).toBe(3);
    // 表格结构完整：表头 + 4 行数据（含 colspan 行）
    expect(container.querySelectorAll("tbody tr").length).toBe(5);
    expect(container.querySelector("td[colspan='2']")?.textContent).toBe(
      "Gradient-State Recurrence",
    );
    // cases 环境依赖 `&amp;` 实体正确解码，渲染失败会产出 katex-error
    expect(container.querySelectorAll(".katex-error").length).toBe(0);
  });

  it("保留公式里的单双竖线语义", () => {
    const container = renderMarkdown(
      `<table><tr><td> $|V|$ </td><td> $\\left| \\overline{\\gamma} \\right|$ </td><td> $\\|x\\|$ </td></tr></table>`,
    );

    const tex = [...container.querySelectorAll("annotation")].map((n) => n.textContent);
    expect(tex).toEqual(["|V|", "\\left| \\overline{\\gamma} \\right|", "\\|x\\|"]);
    expect(container.querySelectorAll(".katex-error").length).toBe(0);
  });

  it("表格单元格里的 $$...$$ 与 \\[...\\] 走 display 模式", () => {
    const container = renderMarkdown(
      `<table><tr><td> $$\\frac{a}{b}$$ </td><td> \\[E=mc^2\\] </td><td> \\(z\\) </td></tr></table>`,
    );

    expect(container.querySelectorAll(".katex-display").length).toBe(2);
    expect(container.querySelectorAll(".katex").length).toBe(3);
    // display 公式仍留在单元格内，没有把表格拆开
    expect(
      [...container.querySelectorAll("td")].every((td) => td.querySelector(".katex") !== null),
    ).toBe(true);
  });

  it("公式里的 `<`、`&` 等字符按 HTML 实体解码后交给 KaTeX", () => {
    const container = renderMarkdown(
      `<table><tr><td> $x &lt; y$ </td><td> $a \\&amp; b$ </td></tr></table>`,
    );

    const tex = [...container.querySelectorAll("annotation")].map((n) => n.textContent);
    expect(tex).toEqual(["x < y", "a \\& b"]);
    expect(container.querySelectorAll(".katex-error").length).toBe(0);
  });

  it("公式里的裸 `<`（未转义）不被当成 HTML 标签", () => {
    // MinerU 实际输出：$L(A + F) < \frac{L}{R}(…)$、$p_\psi(<\mathrm{eos}_{\mathrm{r}}>|s_t)$
    const container = renderMarkdown(
      `<table><tr><td> $L(A + F) < \\frac{L}{R}(A + E \\cdot F_{expert})$ </td><td> $p_\\psi(<\\mathrm{eos}_{\\mathrm{r}}>|s_t)$ </td></tr></table>`,
    );

    const tex = [...container.querySelectorAll("annotation")].map((n) => n.textContent);
    expect(tex).toEqual([
      "L(A + F) < \\frac{L}{R}(A + E \\cdot F_{expert})",
      "p_\\psi(<\\mathrm{eos}_{\\mathrm{r}}>|s_t)",
    ]);
    expect(container.querySelectorAll(".katex-error").length).toBe(0);
  });

  it("表格外的普通 Markdown 公式渲染不受影响", () => {
    const container = renderMarkdown(
      "行内 $a^2 + b^2$ 与\n\n$$\n\\int_0^1 x \\, dx\n$$\n\n以及 `$not_math$` 与 <span>$c$</span>。",
    );

    // 行内 + display + <span> 内共 3 条公式；行内代码不算
    expect(container.querySelectorAll(".katex").length).toBe(3);
    expect(container.querySelectorAll(".katex-display").length).toBe(1);
    expect(container.textContent).toContain("$not_math$");
  });

  it("多行原始 HTML 表格同样渲染，且不吞掉表格后的正文", () => {
    const container = renderMarkdown(
      `<table>
  <tr><td>Method</td><td> $\\alpha_t$ </td></tr>
  <tr><td>Base</td><td> $$\\frac{a}{b}$$ </td></tr>
</table>

后续正文 $x^2$。`,
    );

    expect(container.querySelectorAll("tbody tr").length).toBe(2);
    expect(container.querySelectorAll(".katex-display").length).toBe(1);
    expect(container.querySelectorAll(".katex").length).toBe(3);
    expect(container.textContent).toContain("后续正文");
    expect(container.textContent).not.toContain("$x^2");
  });

  it("表格里的普通文本不受影响（价格等未配对 $ 不误判为公式）", () => {
    const container = renderMarkdown(
      `<table><tr><td> price $100 to $200 </td><td> $x$ </td></tr></table>`,
    );

    expect(container.querySelectorAll(".katex").length).toBe(1);
    expect(container.textContent).toContain("price $100 to $200");
  });
});
