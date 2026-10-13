import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "@/lib/theme";

const css = readFileSync("src/styles.css", "utf8");

/** 取出某个配色方案块的内容（:root[data-scheme="x"] { ... }）。 */
function schemeBlock(scheme: string): string {
  const start = css.indexOf(`:root[data-scheme="${scheme}"]`);
  expect(start, `缺少配色方案块：${scheme}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`配色方案块未闭合：${scheme}`);
}

describe("中英对照中文段跟随配色方案", () => {
  it("消费 --zp-trans-zh 变量，而不是写死颜色", () => {
    const rule = css.slice(css.indexOf(".prose.trans-zh {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("var(--zp-trans-zh)");
    // 写死颜色会让中文段固定成绿色，不再跟随主题
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("不再用 .dark 硬覆盖中文段颜色", () => {
    expect(css).not.toContain(".dark .prose.trans-zh");
  });

  it("每个配色方案都定义了 --zp-trans-zh", () => {
    for (const preset of THEME_PRESETS) {
      expect(schemeBlock(preset.key), preset.key).toMatch(/--zp-trans-zh\s*:/);
    }
  });

  it("默认方案保持原有绿色，深色方案给亮灰", () => {
    expect(schemeBlock("green")).toMatch(/--zp-trans-zh:\s*#32685e/);
    // 深色方案若沿用深色 token，在深底上会变成黑字不可读
    const dark = schemeBlock("dark").match(/--zp-trans-zh:\s*([^;]+);/);
    expect(dark, "深色方案缺少 --zp-trans-zh").not.toBeNull();
    expect(dark![1]).toMatch(/oklch\(0\.8 /);
  });
});
