import { describe, expect, it } from "vitest";
import { parseProgressPercent } from "./utils";
import type { ParseProgress } from "./api";

const p = (stage: string, extracted: number | null = null, total: number | null = null): ParseProgress => ({
  stage,
  extracted_pages: extracted,
  total_pages: total,
});

describe("parseProgressPercent", () => {
  it("各阶段映射为固定百分比", () => {
    expect(parseProgressPercent(p("uploading"))).toBe(5);
    expect(parseProgressPercent(p("pending"))).toBe(10);
    expect(parseProgressPercent(p("converting"))).toBe(15);
    expect(parseProgressPercent(p("downloading"))).toBe(90);
    expect(parseProgressPercent(p("indexing"))).toBe(95);
    expect(parseProgressPercent(p("unknown"))).toBe(0);
  });

  it("running 按页数换算到 15~85 区间", () => {
    expect(parseProgressPercent(p("running", 0, 100))).toBe(15);
    expect(parseProgressPercent(p("running", 50, 100))).toBe(50);
    expect(parseProgressPercent(p("running", 100, 100))).toBe(85);
  });

  it("running 缺页数或总页数为 0 时停留在 15", () => {
    expect(parseProgressPercent(p("running"))).toBe(15);
    expect(parseProgressPercent(p("running", 3, 0))).toBe(15);
  });
});
