import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPage } from '@/pages/Settings';

const mocks = vi.hoisted(() => ({ get: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/api', () => ({
  getSettings: mocks.get, addProvider: mocks.add, updateProvider: mocks.update, deleteProvider: mocks.remove,
  setActiveProvider: vi.fn(), updateSettings: vi.fn(), listCustomThemes: async () => [],
  getThemesDir: async () => '/test/themes', listPapers: async () => [], listJobs: async () => [],
  emptyTrash: vi.fn(), enqueueMetadataTranslations: vi.fn(), reindexAllPapers: vi.fn(),
  generateBlog: vi.fn(), translateChunk: vi.fn(), saveTranslation: vi.fn(),
  DEFAULT_WORKFLOW: { autoParse: false, parseConcurrency: 2 },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => false }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));
const provider = { id: 'qa', name: 'QA provider', provider_type: 'openai-compat', api_key: 'test-only', base_url: 'https://example.invalid/v1', default_model: 'test-model', enabled: true };
const settings = { providers: [provider], active_provider_id: 'qa', mineru_api_key: '', paper_library_path: null, web_search_provider: 'none', web_search_model: null };
beforeEach(() => { mocks.get.mockResolvedValue(structuredClone(settings)); });
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
async function openAI() { render(<SettingsPage />); await screen.findByLabelText('统一标题语言'); fireEvent.click(screen.getByRole('button', { name: 'AI 模型与 API' })); }
async function addCustom() {
  fireEvent.click(screen.getByRole('button', { name: '添加 Provider' }));
  fireEvent.click(screen.getByRole('button', { name: /自定义 OpenAI 兼容/ }));
  fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'test-only' } });
  fireEvent.change(screen.getByLabelText('Base URL *'), { target: { value: 'https://example.invalid/v1' } });
  fireEvent.change(screen.getByLabelText('默认模型 *'), { target: { value: 'custom-model' } });
}
it('edits a provider whose serialized model suggestions were omitted, with MinerU unset', async () => {
  await openAI();
  const card = screen.getByText('QA provider').closest('.rounded-lg')!;
  fireEvent.click(card.querySelector('button')!);
  expect(await screen.findByRole('dialog', { name: '编辑 Provider' })).toBeTruthy();
  expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('test-model');
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'AI 模型与 API' })).toBeTruthy();
});
it('selecting a custom template after going back does not inherit another template endpoint/model', async () => {
  await openAI(); fireEvent.click(screen.getByRole('button', { name: '添加 Provider' }));
  fireEvent.click(screen.getByRole('button', { name: /OpenAI 官方 API/ }));
  fireEvent.click(screen.getByRole('button', { name: /返回/ }));
  fireEvent.click(screen.getByRole('button', { name: /自定义 OpenAI 兼容/ }));
  expect((screen.getByLabelText('Base URL *') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('默认模型 *') as HTMLInputElement).value).toBe('');
});
it('closing and reopening add clears the previous API key and draft', async () => {
  await openAI(); await addCustom(); fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '添加 Provider' }));
  fireEvent.click(screen.getByRole('button', { name: /自定义 OpenAI 兼容/ }));
  expect((screen.getByLabelText('API Key *') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Base URL *') as HTMLInputElement).value).toBe('');
});
it('failed add keeps the draft and exposes the error inside the dialog for retry', async () => {
  mocks.add.mockRejectedValue(new Error('测试保存失败'));
  await openAI(); await addCustom(); fireEvent.click(screen.getByRole('button', { name: '添加', exact: true }));
  const dialog = screen.getByRole('dialog', { name: '添加 AI Provider' });
  await within(dialog).findByRole('alert');
  expect((screen.getByLabelText('API Key *') as HTMLInputElement).value).toBe('test-only');
  expect((screen.getByLabelText('默认模型 *') as HTMLInputElement).value).toBe('custom-model');
});

async function editProvider() {
  await openAI(); fireEvent.click(screen.getByRole('button', { name: '修改 QA provider' }));
  return screen.getByRole('dialog', { name: '编辑 Provider' });
}
it('saves an edited provider without relying on MinerU or model suggestions', async () => {
  mocks.update.mockImplementation(async (_id, config) => ({ ...settings, providers: [config] }));
  await editProvider();
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'updated-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.update).toHaveBeenCalledWith('qa', expect.objectContaining({ default_model: 'updated-model' }));
  expect(screen.getByText('模型：updated-model')).toBeTruthy();
});
it('failed edit keeps the form and can be cancelled without losing the settings page', async () => {
  mocks.update.mockRejectedValue(new Error('测试编辑失败'));
  const dialog = await editProvider();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '未保存的名字' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  expect((await within(dialog).findByRole('alert')).textContent).toContain('测试编辑失败');
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('未保存的名字');
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByText('QA provider')).toBeTruthy();
});
it('empty models and invalid endpoint schemes do not overwrite a working configuration', async () => {
  const dialog = await editProvider();
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: '  ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  expect((await within(dialog).findByRole('alert')).textContent).toContain('默认模型');
  expect(mocks.update).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'valid-model' } });
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'file:///local' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('HTTP'));
  expect(mocks.update).not.toHaveBeenCalled();
});
it('prevents duplicate save requests while an edit is pending', async () => {
  let finish!: (value: unknown) => void;
  mocks.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await editProvider();
  const save = screen.getByRole('button', { name: '保存', exact: true });
  fireEvent.click(save); fireEvent.click(save);
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(save.hasAttribute('disabled')).toBe(true);
  finish(settings);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('deleting an inactive provider requires explicit confirmation and cancel keeps it', async () => {
  mocks.get.mockResolvedValue({ ...settings, providers: [provider, { ...provider, id: 'other', name: 'Other provider', models: [] }] });
  mocks.remove.mockResolvedValue(settings);
  await openAI();
  expect(screen.getByRole('button', { name: '删除 QA provider' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '删除 Other provider' }));
  let dialog = screen.getByRole('dialog', { name: '删除 API 配置？' });
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消', exact: true }));
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(screen.getByText('Other provider')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '删除 Other provider' }));
  dialog = screen.getByRole('dialog', { name: '删除 API 配置？' });
  fireEvent.click(within(dialog).getByRole('button', { name: '删除', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.remove).toHaveBeenCalledWith('other');
  expect(screen.queryByText('Other provider')).toBeNull();
  expect(screen.getByText('QA provider')).toBeTruthy();
});
