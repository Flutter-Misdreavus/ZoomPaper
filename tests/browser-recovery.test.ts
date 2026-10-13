import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });
it('renders recovery actions without inserting page-provided HTML', async () => {
  const html = readFileSync('browser-extension/recovery.html', 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
  const job = {
    paper: { title: '<img src=x onerror=alert(1)>', sourceUrl: 'https://example.org/paper' },
    state: 'error', errors: [{ message: '网络连接失败', url: 'https://example.org/p.pdf' }],
    candidates: [{ label: '全文', url: 'https://example.org/p.pdf' }],
  };
  const sendMessage = vi.fn(async () => ({ job }));
  const create = vi.fn();
  vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } }, tabs: { create } });
  // @ts-expect-error Native extension UI script.
  await import('../browser-extension/recovery.js');
  await vi.waitFor(() => expect(document.getElementById('title')?.textContent).toBe(job.paper.title));
  expect(document.getElementById('title')?.querySelector('img')).toBeNull();
  document.getElementById('source')?.click();
  expect(create).toHaveBeenCalledWith({ url: job.paper.sourceUrl });
  expect(document.querySelectorAll('.candidate button').length).toBe(2);
});
