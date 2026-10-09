import { absoluteUrl } from './detector.js';
import { browserDownloadFilename } from './download.js';

export const MAX_PDF_BYTES = 100 * 1024 * 1024;
const PREFIX = 'import:';
const locks = new Map();

export function downloadProblem(item) {
  if (Math.max(item.totalBytes || 0, item.bytesReceived || 0, item.fileSize || 0) > MAX_PDF_BYTES) return 'PDF 超过 100 MB';
  if (item.state === 'interrupted') return explainDownloadError(item.error);
  if (item.state === 'complete') {
    if (item.exists === false || !item.filename || item.fileSize === 0) return '下载文件为空或已被删除';
    if (item.mime && !/^(application\/(pdf|octet-stream|x-pdf|download|force-download)|binary\/octet-stream)(;|$)/i.test(item.mime)) return '返回的是网页或其他文件，请先完成登录或验证';
  }
  return null;
}

export function explainDownloadError(code = '') {
  if (/USER_CANCELED/.test(code)) return '已取消下载';
  if (/SERVER_UNAUTHORIZED|SERVER_FORBIDDEN/.test(code)) return '网站要求登录、访问权限或浏览器验证';
  if (/NETWORK/.test(code)) return '网络连接失败，请检查代理或在浏览器打开全文';
  if (/FILE/.test(code)) return '无法保存文件，请检查下载目录和磁盘空间';
  return `下载失败${code ? `（${code}）` : ''}`;
}

export function buildImportLink(paper, filename, requestId) {
  const url = new URL('zoompaper://import');
  url.searchParams.set('file', filename);
  url.searchParams.set('request', requestId);
  url.searchParams.set('title', paper.title);
  for (const [key, value] of Object.entries({ source: paper.sourceUrl, github: paper.githubUrl, venue: paper.venue, icon: paper.iconUrl, doi: paper.doi })) {
    if (value) url.searchParams.set(key, value);
  }
  return url.href;
}

export function createImporter(api, receiptFetch = fetch) {
  const save = (job) => api.storage.session.set({ [PREFIX + job.id]: job });
  const load = async (id) => (await api.storage.session.get(PREFIX + id))[PREFIX + id];
  const serialize = (id, task) => {
    const next = (locks.get(id) || Promise.resolve()).catch(() => {}).then(task);
    locks.set(id, next);
    return next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  };
  const recover = async (job) => {
    job.state = 'error';
    await save(job);
    await api.runtime.sendMessage({ type: 'import-updated', id: job.id }).catch(() => {});
    await api.alarms.clear(PREFIX + job.id);
    if (job.recoveryTabId) {
      try { await api.tabs.update(job.recoveryTabId, { active: true }); return; } catch { /* tab closed */ }
    }
    const tab = await api.tabs.create({ url: api.runtime.getURL(`recovery.html?id=${encodeURIComponent(job.id)}`) });
    job.recoveryTabId = tab.id;
    await save(job);
  };
  const startDownload = async (job) => {
    const candidate = job.candidates[job.index];
    if (!candidate || !absoluteUrl(candidate.url, job.paper.sourceUrl)) throw new Error('全文链接必须是公开 HTTPS 地址');
    job.state = 'downloading'; job.downloadId = null;
    await save(job);
    await api.runtime.sendMessage({ type: 'import-updated', id: job.id }).catch(() => {});
    await api.alarms.create(PREFIX + job.id, { when: Date.now() + 120_000 });
    try {
      const id = await api.downloads.download({ url: candidate.url, filename: browserDownloadFilename(job.paper.title, job.id), conflictAction: 'uniquify', saveAs: false });
      job.downloadId = id;
      await save(job);
      await inspect(job.id);
    } catch (error) {
      await failed(job, explainDownloadError(error instanceof Error ? error.message : String(error)));
    }
  };
  const failed = async (job, message) => {
    job.errors.push({ url: job.candidates[job.index]?.url, message });
    // Only metadata-backed routes are tried automatically. Ordinary page links may be other papers.
    const next = job.candidates.findIndex((candidate, index) => index > job.index && candidate.automatic);
    if (message !== '已取消下载' && next >= 0 && job.errors.length < 3) {
      job.index = next;
      await startDownload(job);
    } else await recover(job);
  };
  const acknowledge = async (job) => {
    if (!api.runtime.id) return; // Old extension hosts have no receipt capability.
    try {
      const response = await receiptFetch(`http://127.0.0.1:37541/imports/${job.id}`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      if (response.ok) {
        const receipt = await response.json();
        if (receipt.state === 'accepted') {
          job.state = 'accepted'; job.paperId = receipt.paperId;
          await save(job); await api.alarms.clear(PREFIX + job.id);
          await api.runtime.sendMessage({ type: 'import-updated', id: job.id }).catch(() => {}); return;
        }
        if (receipt.state === 'error') {
          job.errors.push({ message: `App 未保存：${receipt.error}` }); await recover(job); return;
        }
      }
    } catch { /* App launch or permissions may delay the receipt. */ }
    if (Date.now() - job.sentAt > 120_000) {
      job.state = 'unconfirmed'; await save(job);
      // Keep the existing download; retrying the handoff must not download another copy.
      if (!job.recoveryTabId) {
        const tab = await api.tabs.create({ url: api.runtime.getURL(`recovery.html?id=${encodeURIComponent(job.id)}`) });
        job.recoveryTabId = tab.id; await save(job);
      }
      await api.runtime.sendMessage({ type: 'import-updated', id: job.id }).catch(() => {});
    } else await api.alarms.create(PREFIX + job.id, { when: Date.now() + 5000 });
  };
  const inspect = async (id) => {
    const job = await load(id);
    if (!job || job.state !== 'downloading' || job.downloadId == null) return;
    const [item] = await api.downloads.search({ id: job.downloadId });
    if (!item) return;
    const problem = downloadProblem(item);
    if (problem) {
      if (item.state === 'in_progress') await api.downloads.cancel(item.id).catch(() => {});
      if (item.state === 'complete') await api.downloads.removeFile(item.id).catch(() => {});
      await failed(job, problem);
    } else if (item.state === 'complete') {
      job.state = 'handoff'; await save(job);
      await api.alarms.clear(PREFIX + id);
      try {
        await api.tabs.update(job.tabId, { url: buildImportLink(job.paper, item.filename, job.id) });
      } catch {
        await api.tabs.create({ url: buildImportLink(job.paper, item.filename, job.id) });
      }
      job.state = 'sent'; job.sentAt = Date.now(); await save(job);
      await acknowledge(job);
      if (job.recoveryTabId) await api.runtime.sendMessage({ type: 'import-updated', id: job.id }).catch(() => {});
    }
  };
  return {
    async start(paper, candidates, tabId) {
      return serialize(`tab:${tabId}`, async () => {
        // Do not start duplicate downloads from repeated toolbar clicks.
        const jobs = Object.values(await api.storage.session.get(null));
        const active = jobs.find((job) => ['downloading', 'handoff', 'sent', 'unconfirmed'].includes(job?.state) && job.tabId === tabId && job.paper?.sourceUrl === paper.sourceUrl);
        if (active) return active.id;
        const job = { id: crypto.randomUUID(), paper, candidates, tabId, index: 0, errors: [], state: 'new' };
        if (!candidates.length) { job.errors.push({ message: '未找到全文。可粘贴 PDF 地址或在全文链接上右键导入。' }); await recover(job); }
        else await serialize(job.id, () => startDownload(job));
        return job.id;
      });
    },
    async changed(downloadId) {
      const jobs = Object.values(await api.storage.session.get(null));
      const job = jobs.find((value) => value?.state === 'downloading' && value.downloadId === downloadId);
      if (job) await serialize(job.id, () => inspect(job.id));
    },
    async timeout(name) {
      if (!name.startsWith(PREFIX)) return;
      const id = name.slice(PREFIX.length);
      await serialize(id, async () => {
        const before = await load(id);
        if (before?.state === 'sent') { await acknowledge(before); return; }
        await inspect(id);
        const job = await load(id);
        if (job?.state !== 'downloading' || job.downloadId !== before?.downloadId) return;
        if (job.downloadId != null) await api.downloads.cancel(job.downloadId).catch(() => {});
        await failed(job, '下载超时，请在浏览器完成验证后重试');
      });
    },
    load,
    async resend(id) {
      return serialize(id, async () => {
        const job = await load(id);
        if (!job || !['sent', 'unconfirmed'].includes(job.state)) return;
        await acknowledge(job);
        if (job.state === 'accepted' || job.state === 'error') return;
        const [item] = await api.downloads.search({ id: job.downloadId });
        if (!item || downloadProblem(item) || item.state !== 'complete') throw new Error('下载文件已不存在，请回到原网页重新导入');
        await api.tabs.create({ url: buildImportLink(job.paper, item.filename, job.id) });
        job.state = 'sent'; job.sentAt = Date.now(); await save(job); await acknowledge(job);
      });
    },
    async retry(id, rawUrl) {
      return serialize(id, async () => {
        const job = await load(id);
        if (!job || job.state === 'downloading' || job.state === 'sent' || job.state === 'handoff' || job.state === 'accepted' || job.state === 'unconfirmed') return;
        const url = absoluteUrl(rawUrl, job.paper.sourceUrl);
        if (!url) throw new Error('请输入公开 HTTPS 全文地址');
        job.candidates = [{ url, automatic: false, label: '指定全文' }, ...job.candidates.filter((candidate) => candidate.url !== url).map((candidate) => ({ ...candidate, automatic: false }))];
        job.index = 0;
        await startDownload(job);
      });
    },
  };
}
