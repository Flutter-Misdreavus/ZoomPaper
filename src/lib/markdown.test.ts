import { describe, expect, it } from "vitest";
import { linkifyCitations, normalizeLatex } from "@/lib/markdown";

// MinerU 编号公式的典型裸 LaTeX 形态（LLM 回答时剥掉了 $$ 定界符）
const BARE_EQ = String.raw`\Xi(\tau)=\frac{1}{T}\sum_{t=0}^{T-1}\mathcal{H}\left[q_\varphi(\mathbf{z}_{t+1}\mid s_t)\right] \tag{28}`;

describe("normalizeLatex", () => {
  it("单行 $$...$$ 重排为独立 display 块（修复 \\tag 非 display 报错）", () => {
    const out = normalizeLatex(`核心公式为 $$${BARE_EQ}$$ 其中`);
    expect(out).toContain(`\n$$\n${BARE_EQ}\n$$\n`);
  });

  it("裸 LaTeX 公式行自动包裹 $$", () => {
    const out = normalizeLatex(`熵率定义如下：\n\n${BARE_EQ}\n\n其中 T 为步数。`);
    expect(out).toContain(`\n$$\n${BARE_EQ}\n$$\n`);
  });

  it("中文正文行、标题、列表不被误包", () => {
    const md = "其中 \\tau 是温度参数\n\n# 结论\n\n- 见 \\frac{a}{b} 的推导";
    expect(normalizeLatex(md)).toBe(md);
  });

  it("已有 $$ 定界符的行不重复包裹，多行块保持幂等", () => {
    const md = `前文\n\n$$\n${BARE_EQ}\n$$\n\n后文`;
    const once = normalizeLatex(md);
    expect(once).toBe(md);
    expect(normalizeLatex(once)).toBe(once);
  });

  it("\\[...\\] 转换为 display 块", () => {
    const out = normalizeLatex(String.raw`\[E=mc^2\]`);
    expect(out).toContain("$$\nE=mc^2\n$$");
  });

  it("带 \\[...\\] 定界符的行不被裸行包裹二次处理", () => {
    const out = normalizeLatex(String.raw`\[${BARE_EQ}\]`);
    expect(out).toContain(`$$\n${BARE_EQ}\n$$`);
    expect(out).not.toContain("$$$$\n");
  });

  it("代码块内容不受影响", () => {
    const md = "```\n$a + b$\n```";
    expect(normalizeLatex(md)).toBe(md);
  });
});

describe("linkifyCitations", () => {
  it("正文 [n] 转为引用链接", () => {
    expect(linkifyCitations("如文献 [3] 所述")).toBe("如文献 [3](citation:3) 所述");
  });

  it("公式内的下标 [0] 不转链接", () => {
    const md = "公式 $$a_0 + a[0] = b$$ 与 $x[1]$ 成立";
    expect(linkifyCitations(md)).toBe(md);
  });

  it("公式外的 [n] 仍转链接，公式保持原样", () => {
    const out = linkifyCitations("见 [2]，其中 $a[0]=1$");
    expect(out).toBe("见 [2](citation:2)，其中 $a[0]=1$");
  });
});
