/** 本地诊断：localStorage.setItem('zoompaper.performance', '1') 后刷新启用。 */
export interface ReaderPerformanceSample { kind: string; duration: number; }
const samples: ReaderPerformanceSample[] = [];
let pending: { id: string; start: number } | null = null;
let observing = false;
export function performanceEnabled() {
  try { return localStorage.getItem("zoompaper.performance") === "1"; } catch { return false; }
}
export function recordReaderPerformance(kind: string, start: number) {
  if (!performanceEnabled()) return;
  const duration = performance.now() - start;
  samples.push({ kind, duration });
  if (samples.length > 2000) samples.shift();
  try {
    performance.measure(`zoompaper:${kind}`, { start, duration });
    performance.clearMeasures(`zoompaper:${kind}`);
  } catch { /* 旧版 WebView 仍可读取本地样本。 */ }
}
export function beginReaderSwitch(id: string) {
  if (!performanceEnabled()) return;
  pending = { id, start: performance.now() };
  if (!observing && typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    observing = true;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        samples.push({ kind: "longtask", duration: entry.duration });
        if (samples.length > 2000) samples.shift();
      }
    }).observe({ type: "longtask" });
  }
}
export function readerCommitted(id: string) {
  if (!pending || pending.id !== id) return;
  recordReaderPerformance("reader-commit", pending.start);
}
export function readerDisplayed(id: string) {
  const current = pending;
  if (!current || current.id !== id) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (pending !== current) return;
    recordReaderPerformance("switch-display", current.start);
    pending = null;
  }));
}
/** 只返回分类及耗时，不含论文标识或正文。 */
export function getReaderPerformance() { return samples.map(sample => ({ ...sample })); }
export function clearReaderPerformance() { samples.length = 0; pending = null; }

if (typeof window !== "undefined") {
  Object.assign(window, { zoompaperPerformance: { samples: getReaderPerformance, clear: clearReaderPerformance } });
}
