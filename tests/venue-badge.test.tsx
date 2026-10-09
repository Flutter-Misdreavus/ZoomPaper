import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VenueBadge, conferenceIcon } from "../src/components/library/VenueBadge";

describe("VenueBadge", () => {
  it("uses the bundled ICLR icon for recognized ICLR papers", () => {
    expect(conferenceIcon("ICLR 2026", null)).toBe("/venue-icons/iclr.png");
    expect(conferenceIcon(null, "https://proceedings.iclr.cc/paper_files/paper/2026/hash/example.html"))
      .toBe("/venue-icons/iclr.png");

    const { container } = render(<VenueBadge venue="ICLR 2026" sourceUrl="https://proceedings.iclr.cc/paper" compact />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/venue-icons/iclr.png");
  });

  it.each([
    ["ACL 2026", "/venue-icons/acl.png"],
    ["NeurIPS 2026", "/venue-icons/neurips.png"],
    ["CVPR 2026", "/venue-icons/cvf.png"],
    ["ICSE 2026", "/venue-icons/acm.png"],
    ["USENIX Security 2026", "/venue-icons/usenix.png"],
    ["IEEE S&P 2026", "/venue-icons/ieee.jpg"],
    ["PVLDB 2026", "/venue-icons/vldb.png"],
    ["ACM Transactions on Software Engineering and Methodology", "/venue-icons/acm.png"],
    ["IEEE Transactions on Neural Networks and Learning Systems", "/venue-icons/ieee.jpg"],
    ["PLDI 2026", "/venue-icons/acm.png"],
    ["MSR 2026", "/venue-icons/acm.png"],
    ["ICSME 2026", "/venue-icons/ieee.jpg"],
  ])("maps %s to its conference family icon", (venue, icon) => {
    expect(conferenceIcon(venue, null)).toBe(icon);
  });
});

it('recognizes full venue names and does not identify the whole PMLR archive as ICML', () => {
  expect(conferenceIcon('International Conference on Software Engineering 2026', null)).toBe('/venue-icons/acm.png');
  expect(conferenceIcon('International Conference on Machine Learning', null)).toBe('/venue-icons/icml.png');
  expect(conferenceIcon(null, 'https://proceedings.mlr.press/v123/paper.html')).toBeNull();
});
