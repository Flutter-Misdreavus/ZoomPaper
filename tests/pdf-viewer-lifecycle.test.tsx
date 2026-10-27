import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfViewer } from "@/components/PdfViewer";
import { getPdfResourceStats } from "@/lib/pdfResources";
import { getAnnotations } from "@/lib/api";
const pdf = vi.hoisted(() => ({ load: vi.fn(), render: vi.fn(), destroy: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/lib/api", () => ({ getAnnotations: vi.fn().mockResolvedValue(null), saveAnnotations: vi.fn().mockResolvedValue(undefined) }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {}, AnnotationType: { LINK: 2 },
  getDocument: (...args: unknown[]) => pdf.load(...args),
  TextLayer: class { textDivs = []; render() { return Promise.resolve(); } cancel() {} },
}));
class Observer {
  static instances: Observer[] = [];
  elements = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { Observer.instances.push(this); }
  observe(el: Element) { this.elements.add(el); }
  disconnect() { this.elements.clear(); }
  emit() {
    this.callback([...this.elements].map(target => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}
const settle = async () => { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); }); };
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); Observer.instances = [];
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  pdf.destroy.mockResolvedValue(undefined);
  pdf.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel() {} }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    streamTextContent: () => new ReadableStream({ start(controller) { controller.close(); } }),
    getAnnotations: async () => [], render: () => pdf.render(),
  };
  pdf.load.mockImplementation(() => ({
    promise: Promise.resolve({ numPages: 2, getPage: async () => page, getOutline: async () => null }), destroy: pdf.destroy,
  }));
});
afterEach(async () => {
  cleanup(); await settle();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
async function showPages() {
  await settle();
  act(() => { for (const observer of Observer.instances) observer.emit(); });
  await settle();
}

it("切回缓存的论文不重新加载 PDF 或重建已完成画布", async () => {
  const view = render(<PdfViewer pdfPath="paper.pdf" paperId="paper" active />);
  await showPages();
  // 等待首次 fit-width 的防抖完成，稳定后再测切换。
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  const canvas = view.container.querySelector("canvas");
  expect(canvas).not.toBeNull();
  const renders = pdf.render.mock.calls.length;
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active={false} />);
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active />);
  await showPages();
  expect(pdf.load).toHaveBeenCalledTimes(1);
  expect(pdf.render).toHaveBeenCalledTimes(renders);
  expect(view.container.querySelector("canvas")).toBe(canvas);
});

it("淘汰后释放资源，重新进入保留缩放、位置与标注快照", async () => {
  localStorage.setItem("zoompaper:scale:paper", "1.5");
  const view = render(<PdfViewer pdfPath="paper.pdf" paperId="paper" active />);
  await showPages();
  const scroller = view.container.querySelector(".overflow-auto")!;
  scroller.scrollTop = 420; fireEvent.scroll(scroller);
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active={false} retainResources={false} />);
  await settle();
  expect(view.container.querySelector("canvas")).toBeNull();
  expect(pdf.destroy).toHaveBeenCalledTimes(1);
  expect(getPdfResourceStats().documents).toBe(0);
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active retainResources />);
  await showPages();
  expect(pdf.load).toHaveBeenCalledTimes(2);
  expect(getAnnotations).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("zoompaper:scale:paper")).toBe("1.5");
  expect(view.container.querySelector(".overflow-auto")?.scrollTop).toBe(420);
});

it("渲染未完成时快速切换，取消旧任务并正常渲染新画布", async () => {
  pdf.render.mockImplementation(() => {
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((_resolve, fail) => { reject = fail; });
    return { promise, cancel() { reject(new Error("cancelled")); } };
  });
  const view = render(<PdfViewer pdfPath="paper.pdf" paperId="paper" active />);
  await showPages();
  expect(pdf.render).toHaveBeenCalled();
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active={false} />);
  pdf.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel() {} }));
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active />);
  await showPages();
  await waitFor(() => expect(view.container.querySelectorAll("canvas").length).toBe(2));
  expect(view.container.querySelectorAll(".textLayer").length).toBe(2);
});

it("滚回顶部后切换不重放旧跳转，新的外部页码仍能定位", async () => {
  const view = render(<PdfViewer pdfPath="paper.pdf" paperId="paper" active initialPageIdx={1} />);
  await showPages();
  const scroller = view.container.querySelector(".overflow-auto")!;
  scroller.scrollTop = 0; fireEvent.scroll(scroller);
  const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView);
  scrollIntoView.mockClear();
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active={false} initialPageIdx={1} />);
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active initialPageIdx={1} />);
  await settle();
  expect(scrollIntoView).not.toHaveBeenCalled();
  view.rerender(<PdfViewer pdfPath="paper.pdf" paperId="paper" active initialPageIdx={0} />);
  expect(scrollIntoView).toHaveBeenCalled();
  expect((scrollIntoView.mock.instances.at(-1) as HTMLElement).dataset.pageIdx).toBe("0");
});
