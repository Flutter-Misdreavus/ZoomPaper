const BROWSER_SESSION_HOSTS = new Set(["openreview.net", "www.openreview.net"]);

export function requiresBrowserSessionDownload(rawUrl) {
  try {
    return BROWSER_SESSION_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function browserDownloadFilename(title, requestId) {
  const safeTitle = String(title || "paper")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 100) || "paper";
  const suffix = String(requestId || "download").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);
  return `ZoomPaper Imports/${safeTitle}-${suffix || "download"}.pdf`;
}
