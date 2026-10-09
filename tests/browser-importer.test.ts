import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Native extension modules are JavaScript.
import { createImporter, downloadProblem, buildImportLink } from '../browser-extension/importer.js';
// @ts-expect-error Native extension modules are JavaScript.
import { detectPdfCandidates } from '../browser-extension/detector.js';

function fixture() {
  const records: Record<string, any> = {};
  const items: Record<number, any> = {};
  let next = 0;
  const api = {
    storage: { session: {
      get: vi.fn(async (key: string | null) => structuredClone(key ? { [key]: records[key] } : records)),
      set: vi.fn(async (value: any) => Object.assign(records, structuredClone(value))),
    } },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    downloads: {
      download: vi.fn(async () => { items[++next] = { id: next, state: 'in_progress' }; return next; }),
      search: vi.fn(async ({ id }: any) => items[id] ? [items[id]] : []),
      cancel: vi.fn(async () => {}), removeFile: vi.fn(async () => {}),
    },
    tabs: { create: vi.fn(async () => ({ id: 99 })), update: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}) },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: vi.fn(async () => {}) },
  };
  return { api, items, importer: createImporter(api) };
}
const paper = { title: 'Paper', sourceUrl: 'https://new-conference.org/paper' };
const candidates = [
  { url: 'https://new-conference.org/download?id=1', automatic: true, label: '全文' },
  { url: 'https://archive.org/paper.pdf', automatic: true, label: '备用元数据' },
];

describe('browser import recovery', () => {
  it('retains ranked candidates, excludes attachments, and supports unknown publishers', () => {
    const detected = detectPdfCandidates({ pageUrl: paper.sourceUrl, citationPdfUrl: '/download?id=1', links: [
      { href: 'https://arxiv.org/abs/2601.12345', text: 'Preprint' },
      { href: '/supplement.pdf', text: 'Supplement PDF' },
      { href: '/full-text?id=2', text: 'Download PDF' },
    ] });
    expect(detected.map((item: any) => item.url)).toEqual([
      'https://new-conference.org/download?id=1',
      'https://new-conference.org/full-text?id=2',
      'https://arxiv.org/pdf/2601.12345',
    ]);
  });
  it('downloads every host through Chrome and resumes after a worker restart', async () => {
    const { importer, api, items } = fixture();
    const id = await importer.start(paper, candidates, 10);
    items[1] = { id: 1, state: 'complete', mime: 'application/pdf', filename: '/Downloads/ZoomPaper Imports/paper.pdf', fileSize: 500 };
    await createImporter(api).changed(1);
    expect((await importer.load(id)).state).toBe('sent');
    expect(api.tabs.update).toHaveBeenCalledOnce();
    const link = new URL(api.tabs.update.mock.calls[0][1].url);
    expect(link.searchParams.get('file')).toContain('ZoomPaper Imports');
    await importer.changed(1);
    expect(api.tabs.update).toHaveBeenCalledOnce();
  });
  it('tries a trusted alternative after a non-PDF response', async () => {
    const { importer, api, items } = fixture();
    const id = await importer.start(paper, candidates, 10);
    items[1] = { id: 1, state: 'complete', mime: 'text/html', filename: '/tmp/error.pdf', fileSize: 500 };
    await importer.changed(1);
    expect(api.downloads.removeFile).toHaveBeenCalledWith(1);
    expect(api.downloads.download).toHaveBeenCalledTimes(2);
    expect((await importer.load(id)).index).toBe(1);
    expect(api.tabs.update).not.toHaveBeenCalled();
  });
  it('does not automatically download ambiguous page links after failure', async () => {
    const { importer, api, items } = fixture();
    const id = await importer.start(paper, candidates.map((item) => ({ ...item, automatic: false })), 10);
    items[1] = { id: 1, state: 'interrupted', error: 'SERVER_FORBIDDEN' };
    await importer.changed(1);
    expect(api.downloads.download).toHaveBeenCalledOnce();
    expect((await importer.load(id)).state).toBe('error');
    expect(api.tabs.create.mock.calls[0][0].url).toContain('recovery.html');
    await importer.retry(id, 'https://other-conference.org/paper.pdf');
    expect(api.downloads.download).toHaveBeenCalledTimes(2);
  });
  it('opens recovery when no PDF exists and rejects unsafe manual routes', async () => {
    const { importer } = fixture();
    const id = await importer.start(paper, [], 10);
    expect((await importer.load(id)).state).toBe('error');
    await expect(importer.retry(id, 'https://localhost/private.pdf')).rejects.toThrow('HTTPS');
  });
  it('cancels oversized downloads, and does not cancel the next route when a timeout sees a failed route', async () => {
    const { importer, api, items } = fixture();
    const id = await importer.start(paper, candidates, 10);
    items[1] = { id: 1, state: 'interrupted', error: 'NETWORK_FAILED' };
    await importer.timeout(`import:${id}`);
    expect(api.downloads.cancel).not.toHaveBeenCalledWith(2);
    items[2] = { id: 2, state: 'in_progress', bytesReceived: 101 * 1024 * 1024 };
    await importer.changed(2);
    expect(api.downloads.cancel).toHaveBeenCalledWith(2);
    expect((await importer.load(id)).state).toBe('error');
  });
  it('preserves metadata while constructing the local-file handoff', () => {
    const link = new URL(buildImportLink({ ...paper, venue: 'ICLR 2026', iconUrl: 'https://example.org/icon.png' }, '/tmp/paper.pdf', 'request'));
    expect(link.searchParams.get('venue')).toBe('ICLR 2026');
    expect(link.searchParams.get('pdf')).toBeNull();
    expect(downloadProblem({ state: 'complete', filename: '/tmp/file.pdf', fileSize: 0 })).toContain('为空');
  });
});

it('deduplicates simultaneous clicks on the same paper', async () => {
  const { importer, api } = fixture();
  const [first, second] = await Promise.all([importer.start(paper, candidates, 10), importer.start(paper, candidates, 10)]);
  expect(first).toBe(second);
  expect(api.downloads.download).toHaveBeenCalledOnce();
});

it('does not retry or hand off a user-cancelled download', async () => {
  const { importer, api, items } = fixture();
  const id = await importer.start(paper, candidates, 10);
  items[1] = { id: 1, state: 'interrupted', error: 'USER_CANCELED' };
  await importer.changed(1);
  expect(api.downloads.download).toHaveBeenCalledOnce();
  expect(api.tabs.update).not.toHaveBeenCalled();
  expect((await importer.load(id)).errors[0].message).toBe('已取消下载');
});

it('confirms app receipt and recovers from a suspended worker without downloading again', async () => {
  const { api, items } = fixture();
  Object.assign(api.runtime, { id: 'test' });
  const receipt = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'waiting' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'accepted', paperId: 'saved' }) });
  const importer = createImporter(api, receipt);
  const id = await importer.start(paper, candidates, 10);
  items[1] = { id: 1, state: 'complete', mime: 'application/pdf', filename: '/tmp/paper.pdf', fileSize: 500 };
  await importer.changed(1);
  expect((await importer.load(id)).state).toBe('sent');
  const resumed = createImporter(api, receipt);
  await resumed.timeout(`import:${id}`);
  expect((await resumed.load(id)).state).toBe('accepted');
  expect(api.downloads.download).toHaveBeenCalledOnce();
});

it('does not claim import success if the app rejects the file', async () => {
  const { api, items } = fixture();
  Object.assign(api.runtime, { id: 'test' });
  const importer = createImporter(api, vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: 'error', error: 'Disk full' }) }));
  const id = await importer.start(paper, candidates, 10);
  items[1] = { id: 1, state: 'complete', mime: 'application/pdf', filename: '/tmp/paper.pdf', fileSize: 500 };
  await importer.changed(1);
  expect((await importer.load(id)).state).toBe('error');
  expect((await importer.load(id)).errors.at(-1).message).toContain('Disk full');
});
