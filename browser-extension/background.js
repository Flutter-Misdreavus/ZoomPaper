import { detectPaper } from "./detector.js";

const MENU_ID = "add-to-zoompaper";

function setupMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "加入 ZoomPaper",
      contexts: ["page", "link"],
    });
  });
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "ZoomPaper",
    message,
  });
}

function scrapePaperPage() {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || null;
  const metaValues = (selectors) => selectors.flatMap((selector) =>
    [...document.querySelectorAll(selector)].map((element) => element.content || element.href || element.src).filter(Boolean)
  );
  const jsonLdPdfUrls = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((script) => {
    try {
      const root = JSON.parse(script.textContent || "null");
      const pending = Array.isArray(root) ? [...root] : [root];
      const urls = [];
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) {
          pending.push(...value);
          continue;
        }
        if (typeof value.contentUrl === "string" && (/pdf/i.test(value.fileFormat || "") || /\.pdf(?:$|\?)/i.test(value.contentUrl))) {
          urls.push(value.contentUrl);
        }
        pending.push(...Object.values(value).filter((item) => item && typeof item === "object"));
      }
      return urls;
    } catch {
      return [];
    }
  });
  return {
    pageUrl: location.href,
    title: meta("citation_title") || meta("dc.title") || document.querySelector("h1")?.textContent || document.title,
    citationPdfUrl: meta("citation_pdf_url"),
    metaPdfUrls: [
      ...metaValues([
        'meta[name="eprints.document_url"]',
        'meta[name="pdf_url"]',
        'meta[name="fulltext_pdf"]',
        'meta[property="og:pdf"]',
        'link[type="application/pdf"]',
        'link[rel="alternate"][href$=".pdf"]',
        'embed[type="application/pdf"]',
        'iframe[src$=".pdf"]',
      ]),
      ...jsonLdPdfUrls,
    ],
    links: [...document.querySelectorAll("a[href]")].slice(0, 500).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent || "",
      title: anchor.title || "",
      rel: anchor.rel || "",
      type: anchor.type || "",
    })),
  };
}

async function openInZoomPaper(paper, tabId) {
  const deepLink = new URL("zoompaper://import");
  deepLink.searchParams.set("pdf", paper.pdfUrl);
  deepLink.searchParams.set("title", paper.title);
  if (paper.sourceUrl) deepLink.searchParams.set("source", paper.sourceUrl);
  deepLink.searchParams.set("request", crypto.randomUUID());
  await chrome.tabs.update(tabId, { url: deepLink.href });
}

async function detectFromTab(tab, linkUrl) {
  const directUrl = [linkUrl, tab.url].find((value) => {
    try {
      return value && /\.pdf$/i.test(new URL(value).pathname);
    } catch {
      return false;
    }
  });
  if (directUrl) {
    return detectPaper({ pageUrl: tab.url, linkUrl: directUrl, title: tab.title });
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapePaperPage,
  });
  return detectPaper({ ...result, linkUrl });
}

chrome.runtime.onInstalled.addListener(setupMenu);
chrome.runtime.onStartup.addListener(setupMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  try {
    const paper = await detectFromTab(tab, info.linkUrl);
    if (!paper) {
      notify("没有在当前页面找到可导入的 PDF。可在 PDF 链接上再次右键。 ");
      return;
    }
    await openInZoomPaper(paper, tab.id);
  } catch (error) {
    notify(`无法加入 ZoomPaper：${error instanceof Error ? error.message : String(error)}`);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    const paper = await detectFromTab(tab);
    if (!paper) {
      notify("没有在当前页面找到可导入的 PDF。");
      return;
    }
    await openInZoomPaper(paper, tab.id);
  } catch (error) {
    notify(`无法加入 ZoomPaper：${error instanceof Error ? error.message : String(error)}`);
  }
});
