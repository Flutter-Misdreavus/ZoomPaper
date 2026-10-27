import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAnnotations, saveAnnotations } from "@/lib/api";
import { createImageAnnotationStore, imageKey, parseImageAnnotations, type ImageMark } from "./imageAnnotations";
vi.mock("@/lib/api", () => ({ getAnnotations: vi.fn(), saveAnnotations: vi.fn() }));
const note: ImageMark = { id: "n", kind: "note", point: { x: 0.2, y: 0.4 }, text: "细节" };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getAnnotations).mockResolvedValue(null); vi.mocked(saveAnnotations).mockResolvedValue(); });

describe("图片身份与文件保护", () => {
  it("博客相对路径、译文绝对路径与本地访问地址指向同一图片", () => {
    const expected = "/papers/测试/images/fig 1.png";
    for (const src of ["./images/fig%201.png", "images/../images/fig 1.png", expected, "asset://localhost/papers/%E6%B5%8B%E8%AF%95/images/fig%201.png", "http://asset.localhost/papers/%E6%B5%8B%E8%AF%95/images/fig%201.png"]) expect(imageKey(src, "/papers/测试")).toBe(expected);
    expect(imageKey("images/a.png", "c:\\papers\\one")).toBe("C:/papers/one/images/a.png");
    expect(imageKey("http://asset.localhost/C%3A%5Cpapers%5Cone%5Cimages%5Ca.png", "")).toBe("C:/papers/one/images/a.png");
  });
  it("不同论文隔离，外部图片保留完整地址", () => {
    expect(imageKey("images/a.png", "/one")).not.toBe(imageKey("images/a.png", "/two"));
    expect(imageKey("https://example.com/a.png?v=1", "/one")).toBe("https://example.com/a.png?v=1");
  });
  it("拒绝损坏坐标、未知版本和标注类型", () => {
    expect(parseImageAnnotations(null)).toEqual({});
    for (const mark of [{ ...note, point: { x: -1, y: 0 } }, { ...note, kind: "other" }, { ...note, text: " " }]) expect(() => parseImageAnnotations(JSON.stringify({ version: 1, images: { a: [mark] } }))).toThrow();
    expect(() => parseImageAnnotations('{"version":2,"images":{}}')).toThrow();
  });
  it("损坏文件不被覆盖，重新加载成功后才可编辑", async () => {
    vi.mocked(getAnnotations).mockResolvedValueOnce("broken");
    const store = createImageAnnotationStore("one");
    await store.load(); store.update("a", [note]); await store.retry();
    expect(store.getSnapshot().loaded).toBe(false); expect(saveAnnotations).not.toHaveBeenCalled();
    await store.load(); expect(store.getSnapshot().loaded).toBe(true);
  });
});
describe("图片标注保存", () => {
  it("加载前禁止覆盖，加载已有数据后保留其他图片", async () => {
    const store = createImageAnnotationStore("one");
    store.update("a", [note]); expect(saveAnnotations).not.toHaveBeenCalled();
    vi.mocked(getAnnotations).mockResolvedValue(JSON.stringify({ version: 1, images: { b: [note] } }));
    await store.load(); store.update("a", [note]);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("已保存"));
    expect(JSON.parse(vi.mocked(saveAnnotations).mock.calls[0][1]).images).toEqual({ a: [note], b: [note] });
  });
  it("连续修改串行保存最终数据，取消订阅后继续保存", async () => {
    let release!: () => void;
    vi.mocked(saveAnnotations).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const store = createImageAnnotationStore("one"); await store.load();
    const unsubscribe = store.subscribe(() => {});
    store.update("a", [note]); store.update("a", []); store.update("b", [note]); unsubscribe();
    expect(saveAnnotations).toHaveBeenCalledTimes(1); release();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("已保存"));
    expect(saveAnnotations).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(saveAnnotations).mock.calls[1][1]).images).toEqual({ a: [], b: [note] });
  });
  it("失败后保留数据并可重试", async () => {
    vi.mocked(saveAnnotations).mockRejectedValueOnce(new Error("磁盘写入失败"));
    const store = createImageAnnotationStore("one"); await store.load(); store.update("a", [note]);
    await vi.waitFor(() => expect(store.getSnapshot().error).toContain("磁盘写入失败"));
    expect(store.getSnapshot().images.a).toEqual([note]); await store.retry();
    expect(store.getSnapshot().status).toBe("已保存"); expect(store.getSnapshot().error).toBeNull();
  });
});
