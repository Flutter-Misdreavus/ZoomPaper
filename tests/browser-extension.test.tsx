import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// @ts-expect-error 浏览器扩展保持原生 JavaScript，可直接由 Chrome 加载。
import { detectPaper } from "../browser-extension/detector.js";
// @ts-expect-error 浏览器扩展保持原生 JavaScript，可直接由 Chrome 加载。
import { browserDownloadFilename, requiresBrowserSessionDownload } from "../browser-extension/download.js";

describe("browser extension paper detection", () => {
  it("uses the authenticated browser download for OpenReview only", () => {
    expect(requiresBrowserSessionDownload("https://openreview.net/pdf?id=7X91AAKL5B")).toBe(true);
    expect(requiresBrowserSessionDownload("https://arxiv.org/pdf/2601.12345")).toBe(false);
    expect(browserDownloadFilename("A / Paper: title?", "request-123")).toBe(
      "ZoomPaper Imports/A Paper title-request-123.pdf",
    );
  });

  it("keeps a stable extension identity across release folders", () => {
    const manifest = JSON.parse(readFileSync("browser-extension/manifest.json", "utf8"));
    const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
    const id = [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join("");
    expect(id).toBe("fjmflfompjgilhdknkpogjhpjeanndbn");
  });

  it("uses standard academic metadata", () => {
    expect(detectPaper({
      pageUrl: "https://aclanthology.org/2026.acl-long.8/",
      title: "A Paper",
      citationPdfUrl: "/2026.acl-long.8.pdf",
    })).toEqual({
      pdfUrl: "https://aclanthology.org/2026.acl-long.8.pdf",
      title: "A Paper",
      sourceUrl: "https://aclanthology.org/2026.acl-long.8/",
    });
  });

  it("recognizes arXiv and ignores supplementary PDFs", () => {
    expect(detectPaper({
      pageUrl: "https://arxiv.org/abs/2601.12345",
      title: "ArXiv Paper",
      links: [{ href: "/supplement.pdf", text: "Supplement", title: "" }],
    })?.pdfUrl).toBe("https://arxiv.org/pdf/2601.12345");
  });

  it("prefers a selected direct PDF link", () => {
    expect(detectPaper({
      pageUrl: "https://example.org/paper",
      linkUrl: "https://example.org/main.pdf",
      title: "Example",
      citationPdfUrl: "https://example.org/metadata.pdf",
    })?.pdfUrl).toBe("https://example.org/main.pdf");
  });

  it.each([
    [
      "CVF Open Access",
      "https://openaccess.thecvf.com/content/CVPR2025/html/Smith_Useful_Vision_CVPR_2025_paper.html",
      "https://openaccess.thecvf.com/content/CVPR2025/papers/Smith_Useful_Vision_CVPR_2025_paper.pdf",
    ],
    [
      "NeurIPS proceedings",
      "https://proceedings.neurips.cc/paper_files/paper/2025/hash/abc-Abstract-Conference.html",
      "https://proceedings.neurips.cc/paper_files/paper/2025/file/abc-Paper-Conference.pdf",
    ],
    [
      "OpenReview",
      "https://openreview.net/forum?id=paper123",
      "https://openreview.net/pdf?id=paper123",
    ],
  ])("recognizes %s pages", (_site, pageUrl, expected) => {
    expect(detectPaper({ pageUrl, title: "Paper" })?.pdfUrl).toBe(expected);
  });

  it("uses publisher download endpoints and excludes non-paper attachments", () => {
    expect(detectPaper({
      pageUrl: "https://dl.acm.org/doi/10.1145/example",
      title: "ACM Paper",
      links: [
        { href: "/doi/pdf/10.1145/example", text: "View PDF", title: "", type: "application/pdf" },
        { href: "/supplement.pdf", text: "Supplement", title: "", type: "application/pdf" },
      ],
    })?.pdfUrl).toBe("https://dl.acm.org/doi/pdf/10.1145/example");
  });

  it("accepts PDF URLs exposed through JSON-LD or alternate links", () => {
    expect(detectPaper({
      pageUrl: "https://example.org/article/1",
      title: "Metadata Paper",
      metaPdfUrls: ["/download/fulltext?format=pdf"],
    })?.pdfUrl).toBe("https://example.org/download/fulltext?format=pdf");
  });

  it("follows a Researchr preprint landing page to the actual arXiv PDF", () => {
    const sourceUrl = "https://conf.researchr.org/details/icse-2026/research/191/paper";
    expect(detectPaper({
      pageUrl: sourceUrl,
      title: "Minimizing Breaking Changes",
      links: [{
        href: "https://arxiv.org/abs/2511.06762",
        text: "https://arxiv.org/abs/2511.06762",
        context: "Link to Preprint https://arxiv.org/abs/2511.06762",
      }],
    })).toEqual({
      pdfUrl: "https://arxiv.org/pdf/2511.06762",
      title: "Minimizing Breaking Changes",
      sourceUrl,
    });
  });

  it("resolves an arXiv landing link when it is the right-click target", () => {
    expect(detectPaper({
      pageUrl: "https://conf.researchr.org/details/icse-2026/research/191/paper",
      linkUrl: "https://arxiv.org/abs/2511.06762",
      title: "Minimizing Breaking Changes",
    })?.pdfUrl).toBe("https://arxiv.org/pdf/2511.06762");
  });
});
