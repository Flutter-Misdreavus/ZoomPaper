function absoluteUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function isPdfUrl(value) {
  try {
    return /\.pdf$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function looksLikePdfEndpoint(value) {
  return isPdfUrl(value) || /\/pdf(?:\/|\?|$)|download.?pdf|pdfdirect|[?&](?:format|type)=pdf(?:&|$)/i.test(value || "");
}

/** Convert a known paper landing page to its stable PDF endpoint. */
function landingPagePdf(value) {
  try {
    const url = new URL(value);
    if (["arxiv.org", "export.arxiv.org"].includes(url.hostname) && url.pathname.startsWith("/abs/")) {
      return `${url.origin}/pdf/${url.pathname.slice(5)}`;
    }
    if (url.hostname === "openreview.net" && url.pathname === "/forum" && url.searchParams.has("id")) {
      return `${url.origin}/pdf?id=${encodeURIComponent(url.searchParams.get("id"))}`;
    }
    if (url.hostname === "aclanthology.org" && !isPdfUrl(url.href) && /^\/[^/]+\/$/.test(url.pathname)) {
      return `${url.origin}${url.pathname.replace(/\/$/, "")}.pdf`;
    }
  } catch {
    // Ignore malformed candidate URLs.
  }
  return null;
}

const SITE_ADAPTERS = [
  {
    id: "acl-anthology",
    match: (url) => url.hostname === "aclanthology.org" && !isPdfUrl(url.href),
    pdf: (url) => `${url.origin}${url.pathname.replace(/\/$/, "")}.pdf`,
  },
  {
    id: "arxiv",
    match: (url) => ["arxiv.org", "export.arxiv.org"].includes(url.hostname) && url.pathname.startsWith("/abs/"),
    pdf: (url) => `${url.origin}/pdf/${url.pathname.slice(5)}`,
  },
  {
    id: "openreview",
    match: (url) => url.hostname === "openreview.net" && url.pathname === "/forum" && url.searchParams.has("id"),
    pdf: (url) => `${url.origin}/pdf?id=${encodeURIComponent(url.searchParams.get("id"))}`,
  },
  {
    id: "cvf-open-access",
    match: (url) => url.hostname === "openaccess.thecvf.com" && url.pathname.includes("/html/") && url.pathname.endsWith(".html"),
    pdf: (url) => `${url.origin}${url.pathname.replace("/html/", "/papers/").replace(/\.html$/, ".pdf")}`,
  },
  {
    id: "neurips",
    match: (url) => /^(papers|proceedings)\.n(eur)?ips\.cc$/.test(url.hostname) && /-Abstract(?:-Conference)?\.html$/.test(url.pathname),
    pdf: (url) => `${url.origin}${url.pathname.replace("/hash/", "/file/").replace("-Abstract", "-Paper").replace(/\.html$/, ".pdf")}`,
  },
];

function candidateScore(link) {
  const description = `${link.text || ""} ${link.title || ""} ${link.context || ""} ${link.rel || ""} ${link.type || ""}`;
  const href = link.href || "";
  if (/checklist|supplement|appendix|attachment|slides|poster|code/i.test(`${description} ${href}`)) return -100;
  let score = 0;
  if (/application\/pdf/i.test(link.type || "")) score += 8;
  if (/^(pdf|download pdf|paper|full text|full text pdf)$/i.test((link.text || "").trim())) score += 7;
  if (/pdf|full.?text|download/i.test(description)) score += 4;
  if (isPdfUrl(href)) score += 5;
  if (looksLikePdfEndpoint(href)) score += 3;
  if (landingPagePdf(href)) score += 5;
  if (/pre-?print|paper|full.?text/i.test(description)) score += 3;
  return score;
}

export function detectPaper({
  pageUrl,
  linkUrl,
  title,
  citationPdfUrl,
  metaPdfUrls = [],
  links = [],
}) {
  const page = absoluteUrl(pageUrl, pageUrl);
  const selectedLink = absoluteUrl(linkUrl, pageUrl);
  const citation = absoluteUrl(citationPdfUrl, pageUrl);
  let pdfUrl = isPdfUrl(selectedLink) ? selectedLink : landingPagePdf(selectedLink) || citation;

  if (!pdfUrl) {
    pdfUrl = metaPdfUrls
      .map((value) => absoluteUrl(value, pageUrl))
      .find((value) => value && looksLikePdfEndpoint(value)) || null;
  }

  if (!pdfUrl && page) {
    const url = new URL(page);
    const adapter = SITE_ADAPTERS.find((candidate) => candidate.match(url));
    if (adapter) {
      pdfUrl = adapter.pdf(url);
    } else if (isPdfUrl(page)) {
      pdfUrl = page;
    }
  }

  if (!pdfUrl) {
    const candidates = links
      .map((link) => ({ ...link, href: absoluteUrl(link.href, pageUrl) }))
      .filter((link) => link.href)
      .map((link) => ({ ...link, score: candidateScore(link) }))
      .filter((link) => link.score >= 5)
      .sort((a, b) => b.score - a.score);
    pdfUrl = candidates[0] ? landingPagePdf(candidates[0].href) || candidates[0].href : null;
  }

  return pdfUrl ? { pdfUrl, title: title?.trim() || "未命名论文", sourceUrl: page } : null;
}
