import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaperWorkspace } from '@/components/PaperWorkspace';
const renders=vi.hoisted(()=>({library:vi.fn(),reader:vi.fn()}));
vi.mock('@/lib/api', () => ({ listPapers: async () => [{id:'a',title:'a'},{id:'b',title:'b'}], getPaper: async (id:string) => ({id,title:id}) }));
vi.mock('@/pages/Library', () => ({ Library: ({onOpenPaper,onOpenPapers}:any) => {renders.library();return <div><button onClick={() => onOpenPaper('a')}>open-a</button><button onClick={() => onOpenPaper('b')}>open-b</button><button onClick={() => onOpenPapers(['a','b'])}>open-many</button></div>;} }));
vi.mock('@/pages/Reader', () => ({ Reader: ({paperId,active}:any) => {renders.reader(paperId);return <div data-testid={`reader-${paperId}`} data-active={String(active)}><input aria-label={`draft-${paperId}`} /></div>;} }));
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
afterEach(() => {cleanup();localStorage.clear();vi.clearAllMocks();});
it('retains reader drafts across tabs and global navigation', async () => {
  const props = {active:true,jobs:[],refreshSignal:0,onTitleChange:vi.fn()};
  const view = render(<PaperWorkspace {...props} />);
  await waitFor(() => expect(screen.getByText('open-a')).toBeTruthy());
  fireEvent.click(screen.getByText('open-a'));
  fireEvent.change(screen.getByLabelText('draft-a'),{target:{value:'unfinished question'}});
  fireEvent.click(screen.getByText('open-b'));
  expect(screen.getByTestId('reader-a').dataset.active).toBe('false');
  view.rerender(<PaperWorkspace {...props} active={false} />);
  expect(screen.getByTestId('reader-b').dataset.active).toBe('false');
  view.rerender(<PaperWorkspace {...props} />);
  expect((screen.getByLabelText('draft-a') as HTMLInputElement).value).toBe('unfinished question');
});
it('creates background tabs without loading their readers', async () => {
  render(<PaperWorkspace active jobs={[]} refreshSignal={0} onTitleChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('open-many')).toBeTruthy());
  fireEvent.click(screen.getByText('open-many'));
  expect(screen.queryByTestId('reader-a')).toBeNull();
  expect(screen.queryByTestId('reader-b')).toBeNull();
  expect(screen.getAllByRole('tab')).toHaveLength(3);
});

it('closes all tabs and restores drafts with undo', async () => {
  render(<PaperWorkspace active jobs={[]} refreshSignal={0} onTitleChange={vi.fn()} />);
  fireEvent.click(screen.getByText('open-a'));
  fireEvent.change(screen.getByLabelText('draft-a'),{target:{value:'kept draft'}});
  fireEvent.click(screen.getByText('open-b'));
  await waitFor(() => expect(screen.getByRole('tab', {name:'b'})).toBeTruthy());
  fireEvent.click(screen.getByLabelText('全部论文标签'));
  expect(screen.queryByText('关闭其他标签')).toBeNull();
  expect(screen.queryByText('关闭全部标签')).toBeNull();
  expect(screen.queryByText('恢复最近关闭')).toBeNull();
  fireEvent.change(screen.getByLabelText('搜索打开的论文'), {target:{value:'b'}});
  expect(screen.queryByLabelText('关闭列表中的 a')).toBeNull();
  expect(screen.getByLabelText('关闭列表中的 b')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('关闭全部论文标签'));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  fireEvent.click(screen.getByText('撤销'));
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect((screen.getByLabelText('draft-a') as HTMLInputElement).value).toBe('kept draft');
});
it('restores saved tabs and loads only the active reader', async () => {
  localStorage.setItem('zoompaper.workspace', JSON.stringify({tabs:['a','b'],active:'b',lastRead:'b'}));
  render(<PaperWorkspace active jobs={[]} refreshSignal={0} onTitleChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('tab',{name:'b'})).toBeTruthy());
  expect(screen.getByTestId('reader-b')).toBeTruthy();
  expect(screen.queryByTestId('reader-a')).toBeNull();
});

it('does not rerender the hidden library when switching reader tabs',async()=>{
 render(<PaperWorkspace active jobs={[]} refreshSignal={0} onTitleChange={vi.fn()}/>);fireEvent.click(screen.getByText('open-a'));fireEvent.click(screen.getByText('open-b'));await waitFor(()=>expect(screen.getByRole('tab',{name:'b'})).toBeTruthy());const count=renders.library.mock.calls.length;fireEvent.click(screen.getByRole('tab',{name:'a'}));fireEvent.click(screen.getByRole('tab',{name:'b'}));expect(renders.library).toHaveBeenCalledTimes(count);expect(screen.getByTestId('reader-a')).toBeTruthy();
});
