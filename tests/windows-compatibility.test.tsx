import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownView } from '@/components/MarkdownView';
import { linkifyCitations } from '@/lib/markdown';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
}));
afterEach(cleanup);

it('renders an image at a Windows drive path containing Chinese and spaces', () => {
  render(<MarkdownView markdown={'![figure](<D:/论文库/My Paper/images/figure.png>)'} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    `http://asset.localhost/${encodeURIComponent('D:/论文库/My Paper/images/figure.png')}`,
  );
});

it('preserves an existing citation link when processing the answer again', () => {
  const answer = '证据 [1](citation:1)，外部来源 [2](https://example.org/paper)，另见 [3]';
  expect(linkifyCitations(answer)).toBe(
    '证据 [1](citation:1)，外部来源 [2](https://example.org/paper)，另见 [3](citation:3)',
  );
  expect(linkifyCitations(linkifyCitations('见 [1]'))).toBe(linkifyCitations('见 [1]'));
});

it('keeps executable protocols blocked in Markdown images and links', () => {
  render(<MarkdownView markdown={'![bad](javascript:alert%281%29)\n\n[bad](javascript:alert%281%29)'} />);
  expect(screen.getByRole('img').getAttribute('src')).toBeFalsy();
  expect(screen.getByText('bad', { selector: 'a' }).getAttribute('href')).toBeFalsy();
});
