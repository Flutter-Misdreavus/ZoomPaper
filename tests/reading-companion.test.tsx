import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReadingCompanion, jobLabel } from '@/components/ReadingCompanion';
import type { BackgroundJob } from '@/lib/api';
vi.mock('@/lib/api', () => ({ cancelJob: vi.fn().mockResolvedValue(undefined), retryJob: vi.fn().mockResolvedValue(undefined) }));
const job: BackgroundJob = { id: 'job', paper_id: 'paper', title: 'A Paper', kind: 'parse', status: 'running', stage: 'pending', completed_pages: null, total_pages: null, error: null, created_at: 1, updated_at: 1 };
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
afterEach(() => { cleanup(); localStorage.clear(); });
it('dismisses busy status without canceling tasks and can restore the task bubble', async () => {
  const dismiss = vi.fn();
  render(<ReadingCompanion jobs={[job]} notice={null} readingTitle={null} onDismiss={dismiss} onOpenPaper={vi.fn()} />);
  expect(screen.getByText('云端排队 A Paper')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('关闭提示'));
  expect(dismiss).toHaveBeenCalledOnce();
  const api = await import('@/lib/api');
  expect(api.cancelJob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('展开阅读伙伴'));
  expect(screen.getByLabelText('任务气泡')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('展开任务内容'));
  fireEvent.click(screen.getByLabelText('取消 解析'));
  expect(api.cancelJob).toHaveBeenCalledWith('job');
});
it('shows current reading when no background task is running', () => {
  render(<ReadingCompanion jobs={[]} notice={null} readingTitle="Another Paper" onDismiss={vi.fn()} onOpenPaper={vi.fn()} />);
  expect(screen.getByLabelText('任务气泡')).toBeTruthy();
  expect(screen.getByText('正在阅读 Another Paper')).toBeTruthy();
  expect(screen.getByLabelText('阅读伙伴')).toBeTruthy();
});
it('distinguishes postprocessing from parsing', () => {
  expect(jobLabel({ ...job, kind: 'index' })).toBe('正在建立索引');
  expect(jobLabel({ ...job, status: 'canceling' })).toBe('正在停止');
  expect(jobLabel({ ...job, kind: 'doi', status: 'failed' })).toBe('补全出版信息失败');
});

it('limits the bubble to two lines and expands details only on click', () => {
  render(<ReadingCompanion jobs={[{ ...job, status: 'failed', error: '服务暂不可用' }]} notice={{ phase: "error", title: "A Paper", message: "网络失败" }} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('服务暂不可用')).toBeNull();
  expect(screen.getByLabelText('展开任务内容').className).toContain('line-clamp-2');
  fireEvent.click(screen.getByLabelText('展开任务内容'));
  expect(screen.getByText('服务暂不可用')).toBeTruthy();
  const pet = screen.getByLabelText('阅读伙伴');
  const bubble = screen.getByLabelText('任务气泡');
  expect(pet.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pet.closest('.fixed')!.className).toContain('top-5');
});

it('dismisses completed import after five seconds despite callback rerenders', () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const props = { jobs: [], notice: { phase: 'done' as const, title: 'A Paper', message: '' }, readingTitle: null, onOpenPaper: vi.fn() };
  const view = render(<ReadingCompanion {...props} onDismiss={() => dismiss()} />);
  vi.advanceTimersByTime(3000);
  view.rerender(<ReadingCompanion {...props} onDismiss={() => dismiss()} />);
  vi.advanceTimersByTime(2000);
  expect(dismiss).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it('offers only import and resume actions after activating the pet', () => {
  const onImport = vi.fn(), onContinue = vi.fn(), hide = vi.fn();
  render(<ReadingCompanion jobs={[]} notice={null} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} onImport={onImport} onContinue={onContinue} onHide={hide} />);
  expect(screen.queryByLabelText('导入论文')).toBeNull();
  fireEvent.keyDown(screen.getByLabelText('阅读伙伴'), {key:'Enter'});
  fireEvent.click(screen.getByLabelText('导入论文'));
  expect(onImport).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText('继续阅读')).toBeNull();
  fireEvent.keyDown(screen.getByLabelText('阅读伙伴'), {key:'Enter'});
  fireEvent.click(screen.getByLabelText('继续阅读'));
  expect(onContinue).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByLabelText('隐藏阅读伙伴'));
  expect(hide).toHaveBeenCalledOnce();
});

it('starts dragging on the first pixel of movement and never activates actions after a drag', () => {
  const original = window.PointerEvent;
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  const drag = vi.fn();
  render(<ReadingCompanion jobs={[]} notice={null} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} onNativeDrag={drag} />);
  const pet = screen.getByLabelText('阅读伙伴');
  fireEvent.pointerDown(pet, {button:0,screenX:10,screenY:10});
  expect(drag).not.toHaveBeenCalled();
  fireEvent.pointerMove(pet, {screenX:10,screenY:10});
  expect(drag).not.toHaveBeenCalled();
  fireEvent.pointerMove(pet, {screenX:11,screenY:10});
  expect(drag).toHaveBeenCalledOnce();
  fireEvent.pointerUp(pet);
  expect(screen.queryByLabelText('导入论文')).toBeNull();
  fireEvent.pointerDown(pet, {button:0,screenX:10,screenY:10});
  fireEvent.pointerUp(pet);
  expect(screen.getByLabelText('导入论文')).toBeTruthy();
  fireEvent.pointerEnter(pet);
  expect(screen.getByLabelText('导入论文')).toBeTruthy();
  window.PointerEvent = original;
});

it('shows local translation progress without exposing a backend cancel action', () => {
  render(<ReadingCompanion jobs={[{...job,kind:'full_translation',local:true,completed_pages:2,total_pages:5}]} notice={null} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('展开任务内容'));
  expect(screen.getByText(/2\/5 段/)).toBeTruthy();
  expect(screen.queryByLabelText('取消 全文翻译')).toBeNull();
});
it('leaves the idle pet without a bubble or action buttons', () => {
  render(<ReadingCompanion jobs={[]} notice={null} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} />);
  expect(screen.queryByLabelText('任务气泡')).toBeNull();
  expect(screen.queryByLabelText('导入论文')).toBeNull();
  fireEvent.pointerEnter(screen.getByLabelText('阅读伙伴'));
  expect(screen.getByLabelText('导入论文').className).toContain('companion-glass');
});

it('uses the whole pet surface to begin a desktop gesture and waits for the native result',()=>{
 const original=window.PointerEvent;window.PointerEvent=MouseEvent as typeof PointerEvent;
 const press=vi.fn().mockResolvedValue(undefined),release=vi.fn().mockResolvedValue(undefined);
 render(<ReadingCompanion jobs={[]} notice={null} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} onNativePress={press} onNativeRelease={release}/>);
 const pet=screen.getByLabelText('阅读伙伴');expect(pet.getAttribute('data-companion-hit')).toBe('pet');
 fireEvent.pointerDown(pet,{button:0,clientX:160,clientY:46});expect(press).toHaveBeenCalledWith(160,46);
 fireEvent.pointerMove(pet,{screenX:300,screenY:200});fireEvent.pointerUp(pet);expect(release).toHaveBeenCalledOnce();
 fireEvent(window,new CustomEvent('companion:gesture-end',{detail:false}));expect(screen.getByLabelText('导入论文')).toBeTruthy();
 fireEvent.pointerDown(pet,{button:0,clientX:160,clientY:46});fireEvent(window,new Event('companion:gesture-dragging'));fireEvent(window,new CustomEvent('companion:gesture-end',{detail:true}));expect(screen.queryByLabelText('导入论文')).toBeNull();
 window.PointerEvent=original;
});

// The transparent gap between quick actions overlaps the owl's body.
it('keeps the quick-action gap transparent to pointer input while buttons remain clickable', () => {
  render(<ReadingCompanion jobs={[]} notice={null} readingTitle={null} onDismiss={vi.fn()} onOpenPaper={vi.fn()} />);
  fireEvent.pointerEnter(screen.getByLabelText('阅读伙伴'));
  const button = screen.getByLabelText('导入论文');
  expect(button.className).toContain('pointer-events-auto');
  expect(button.closest('.pointer-events-none')).toBeTruthy();
  expect(screen.getByLabelText('继续阅读').className).toContain('pointer-events-auto');
  expect(screen.getByLabelText('阅读伙伴').className).toContain('cursor-grab');
});
