import { scrapePaperPage } from "./scrape.js";
import { detectPaper, detectPdfCandidates } from "./detector.js";
import { createImporter } from "./importer.js";
const importer = createImporter(chrome);

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

async function openInZoomPaper(paper, tabId) {
  await importer.start(paper, paper.candidates || [], tabId);
}

async function detectFromTab(tab, linkUrl) {
  const directUrl = [linkUrl, tab.url].find((value) => {
    try {
      return value && /\.pdf$/i.test(new URL(value).pathname);
    } catch {
      return false;
    }
  });
  if (directUrl && /\.pdf$/i.test(new URL(tab.url).pathname)) {
    const paper = detectPaper({ pageUrl: tab.url, linkUrl: directUrl, title: tab.title });
    return { ...(paper || { title: tab.title || "论文", sourceUrl: tab.url }), candidates: detectPdfCandidates({ pageUrl: tab.url, linkUrl: directUrl }), iconUrl: tab.favIconUrl || null };
  }
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePaperPage });
  } catch {
    // Chrome's PDF viewer and restricted pages may reject script injection.
    result = { pageUrl: tab.url, title: tab.title };
  }
  const paper = detectPaper({ ...result, linkUrl });
  return { ...(paper || { title: result.title || "论文", sourceUrl: result.pageUrl }), candidates: detectPdfCandidates({ ...result, linkUrl }), doi: result.doi || null, iconUrl: result.iconUrl || tab.favIconUrl || null };
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

// Registered at worker startup so downloads survive service-worker suspension.
chrome.downloads.onChanged.addListener((delta) => { importer.changed(delta.id).catch((error) => notify(String(error))); });
chrome.alarms.onAlarm.addListener((alarm) => { importer.timeout(alarm.name).catch((error) => notify(String(error))); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL('recovery.html'))) return;
  const action = message.type === 'import-load' ? importer.load(message.id)
    : message.type === 'import-retry' ? importer.retry(message.id, message.url)
    : message.type === 'import-resend' ? importer.resend(message.id) : null;
  if (!action) return;
  action.then((job) => reply({ job })).catch((error) => reply({ error: String(error.message || error) }));
  return true;
});
