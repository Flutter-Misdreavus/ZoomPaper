import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageAnnotationProvider, AnnotatableImage } from "./ImageAnnotationViewer";
import { getAnnotations, saveAnnotations } from "@/lib/api";
vi.mock("@/lib/api", () => ({ getAnnotations: vi.fn(), saveAnnotations: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost${path}` }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerId = 1; pointerType = "mouse"; });
  vi.mocked(getAnnotations).mockResolvedValue(JSON.stringify({ version: 1, images: { "/papers/images/a.png": [{ id: "n", kind: "note", point: { x: 0.5, y: 0.5 }, text: "旧备注" }] } }));
  vi.mocked(saveAnnotations).mockResolvedValue();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private resize: ResizeObserverCallback) {}
    observe() {
      this.resize([{ contentRect: { width: 1000, height: 800 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
let index = 0;
function mount() {
  return render(<ImageAnnotationProvider paperId={`viewer-test-${index++}`} baseDir="/papers" active><div data-testid="body"><AnnotatableImage src="images/a.png" alt="图一" /><AnnotatableImage src="/papers/images/a.png" alt="译文图一" /><span>正文文字</span></div></ImageAnnotationProvider>);
}
async function dismissByBackdrop() {
  // Radix 在下一轮事件循环注册外部 pointerdown，模拟真实用户随后点击遮罩。
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
  expect(overlay).toBeTruthy();
  await act(async () => {
    fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.click(overlay);
  });
}
it("共享图片标注提示不改变正文文字；可编辑、撤销、重做和删除备注", async () => {
  mount();
  await waitFor(() => expect(screen.getAllByLabelText("有标注")).toHaveLength(2));
  expect(screen.getByTestId("body").textContent).toBe("正文文字");
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  const image = screen.getByRole("dialog").querySelector("img")!;
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  fireEvent.load(image);
  fireEvent.click(screen.getByRole("button", { name: "备注 1：旧备注" }));
  fireEvent.change(screen.getByLabelText("备注内容"), { target: { value: "新的理解" } });
  fireEvent.click(screen.getByText("保存备注"));
  expect(screen.getByRole("button", { name: "备注 1：新的理解" })).toBeTruthy();
  fireEvent.click(screen.getByText("撤销"));
  expect(screen.getByRole("button", { name: "备注 1：旧备注" })).toBeTruthy();
  fireEvent.click(screen.getByText("重做"));
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "备注 1：新的理解" }));
  expect(screen.queryByRole("button", { name: /备注 1/ })).toBeNull();
  expect(screen.queryAllByLabelText("有标注")).toHaveLength(0);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
});
it("无退出按钮，点击灰暗遮罩关闭时保存备注，重开可恢复", async () => {
  mount();
  await waitFor(() => expect(screen.getAllByLabelText("有标注")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  const image = screen.getByRole("dialog").querySelector("img")!;
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  fireEvent.load(image);
  fireEvent.click(screen.getByRole("button", { name: "备注 1：旧备注" }));
  fireEvent.change(screen.getByLabelText("备注内容"), { target: { value: "关闭时保留" } });
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  await dismissByBackdrop();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "放大图片：译文图一" }));
  expect(screen.getByLabelText("备注 1：关闭时保留")).toBeTruthy();
  expect((screen.getByText("撤销") as HTMLButtonElement).disabled).toBe(true);
});
it("损坏文件可查看图片但禁止标注，显示加载错误", async () => {
  vi.mocked(getAnnotations).mockResolvedValue("bad json");
  mount();
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("标注加载失败"));
  expect((screen.getByRole("button", { name: "画笔" }) as HTMLButtonElement).disabled).toBe(true);
  expect(saveAnnotations).not.toHaveBeenCalled();
});
it("缩放后画笔按图片坐标保存，取消的笔迹不落盘，并支持整笔删除", async () => {
  vi.mocked(getAnnotations).mockResolvedValue(null);
  vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerId = 1; });
  mount();
  await waitFor(() => expect(getAnnotations).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  const img = screen.getByRole("dialog").querySelector("img")!;
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  fireEvent.load(img);
  const canvas = img.parentElement!;
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, width: 400, height: 300 } as DOMRect);
  fireEvent.click(screen.getByRole("button", { name: "画笔" }));
  fireEvent.click(screen.getByRole("button", { name: "蓝色" }));
  fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
  fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 175 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 250 });
  fireEvent.pointerUp(canvas, { clientX: 400, clientY: 325 });
  await waitFor(() => expect(saveAnnotations).toHaveBeenCalledTimes(1));
  const stroke = JSON.parse(vi.mocked(saveAnnotations).mock.calls[0][1]).images["/papers/images/a.png"][0];
  expect(stroke.color).toBe("#3b82f6");
  expect(stroke.points).toEqual([{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }]);
  fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 175 });
  fireEvent.pointerCancel(canvas);
  expect(saveAnnotations).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "删除笔迹" }));
  await waitFor(() => expect(screen.queryAllByLabelText("有标注")).toHaveLength(0));
});
it("Esc 关闭弹窗时提交非空备注", async () => {
  mount();
  await waitFor(() => expect(screen.getAllByLabelText("有标注")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  fireEvent.click(screen.getByLabelText("备注 1：旧备注"));
  fireEvent.change(screen.getByLabelText("备注内容"), { target: { value: "Esc 保留" } });
  await act(async () => { fireEvent.keyDown(screen.getByLabelText("备注内容"), { key: "Escape", code: "Escape" }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(saveAnnotations).toHaveBeenCalled());
  expect(JSON.parse(vi.mocked(saveAnnotations).mock.calls[vi.mocked(saveAnnotations).mock.calls.length - 1][1]).images["/papers/images/a.png"][0].text).toBe("Esc 保留");
});
it("弹窗实际挂载后测量画布，图片以可见尺寸显示，缩放窗口和重开时重新测量", async () => {
  const observers: { resize: ResizeObserverCallback; element?: Element; disconnect: () => void }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    private record: (typeof observers)[number];
    constructor(resize: ResizeObserverCallback) {
      this.record = { resize, disconnect: vi.fn() };
      observers.push(this.record);
    }
    observe(element: Element) {
      this.record.element = element;
      this.record.resize([{ contentRect: { width: 1000, height: 800 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() { this.record.disconnect(); }
  });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  const img = screen.getByRole("dialog").querySelector("img")!;
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  fireEvent.load(img);
  const canvas = img.parentElement!;
  expect(parseFloat(canvas.parentElement!.style.aspectRatio)).toBeCloseTo(800 / 600);
  expect(screen.getByRole("toolbar", { name: "图片工具" })).toBeTruthy();
  expect(observers).toHaveLength(1);
  expect(observers[0].element).toBe(canvas.parentElement);
  expect(parseFloat(canvas.style.width)).toBeCloseTo(1000);
  expect(parseFloat(canvas.style.height)).toBeCloseTo(750);
  act(() => observers[0].resize([{ contentRect: { width: 432, height: 332 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(parseFloat(canvas.style.width)).toBeCloseTo(432);
  expect(parseFloat(canvas.style.height)).toBeCloseTo(324);
  await dismissByBackdrop();
  expect(observers[0].disconnect).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "放大图片：图一" }));
  expect(observers).toHaveLength(2);
});
