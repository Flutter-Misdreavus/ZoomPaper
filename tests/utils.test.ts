import { describe, expect, it } from "vitest";
import { displayPaperTitle } from "@/lib/utils";

describe("displayPaperTitle", () => {
  it("turns scholarly title markup into compact plain text", () => {
    expect(displayPaperTitle("NavA<sup>3</sup>: A &amp; B")).toBe("NavA³: A & B");
  });
});
