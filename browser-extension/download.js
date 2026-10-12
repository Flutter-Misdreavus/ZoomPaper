import { absoluteUrl } from './detector.js';

// All public HTTPS sources now use Chrome, including unrecognized conference hosts.
export function requiresBrowserSessionDownload(rawUrl) {
  return Boolean(absoluteUrl(rawUrl, rawUrl));
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
