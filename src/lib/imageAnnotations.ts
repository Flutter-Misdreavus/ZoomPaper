import { getAnnotations, saveAnnotations } from "@/lib/api";

export type ImagePoint = { x: number; y: number };
export type ImageMark =
  | { id: string; kind: "stroke"; points: ImagePoint[]; color: string; width: number }
  | { id: string; kind: "note"; point: ImagePoint; text: string };
export type ImageAnnotations = Record<string, ImageMark[]>;
type Snapshot = { images: ImageAnnotations; loaded: boolean; status: string; error: string | null };

/** 图片身份使用规范化源路径，不依赖 WebView 的临时访问地址。 */
export function imageKey(src: string, baseDir: string): string {
  if (/^(https?:|data:|blob:)/i.test(src) && !/^https?:\/\/asset\.localhost\//i.test(src)) return src;
  let value = src;
  try { value = decodeURIComponent(value); } catch { /* 保留不完整编码 */ }
  value = value.replace(/^asset:\/\/(?:localhost\/)?/i, "/").replace(/^https?:\/\/asset\.localhost\//i, "/");
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  value = value.replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1");
  if (!/^(\/|[A-Za-z]:\/)/.test(value)) value = `${baseDir.replace(/\\/g, "/")}/${value}`;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "") parts.pop();
    else if (part !== "..") parts.push(part);
  }
  return parts.join("/").replace(/^[a-z]:/, drive => drive.toUpperCase());
}

export function parseImageAnnotations(raw: string | null): ImageAnnotations {
  if (!raw) return {};
  const file = JSON.parse(raw);
  const point = (p: ImagePoint) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  if (file?.version !== 1 || !file.images || typeof file.images !== "object" || Array.isArray(file.images)) throw new Error("图片标注文件格式无效，已停止保存以保护原文件");
  for (const marks of Object.values(file.images)) {
    if (!Array.isArray(marks) || !marks.every((m: ImageMark) => m && typeof m.id === "string" && (
      m.kind === "stroke" ? Array.isArray(m.points) && m.points.length > 0 && m.points.every(point) && /^#[0-9a-f]{6}$/i.test(m.color) && Number.isFinite(m.width) && m.width > 0 && m.width <= 1
        : m.kind === "note" && point(m.point) && typeof m.text === "string" && !!m.text.trim()
    ))) throw new Error("图片标注条目损坏，已停止保存以保护原文件");
  }
  return file.images;
}

/** 应用级存储：切换视图、关闭阅读页后仍完成排队保存，并保留失败数据供重试。 */
export function createImageAnnotationStore(paperId: string) {
  let snapshot: Snapshot = { images: {}, loaded: false, status: "正在加载标注…", error: null };
  const listeners = new Set<() => void>();
  let loading = false;
  let revision = 0;
  let writing = false;
  const publish = (next: Partial<Snapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(fn => fn()); };
  const save = async () => {
    if (!snapshot.loaded || writing) return;
    writing = true;
    publish({ status: "正在保存…", error: null });
    try {
      let saved: number;
      do {
        saved = revision;
        await saveAnnotations(paperId, JSON.stringify({ version: 1, images: snapshot.images }), "image");
      } while (saved !== revision);
      publish({ status: "已保存", error: null });
    } catch (e) { publish({ status: "保存失败", error: `图片标注保存失败：${String(e)}` }); }
    finally { writing = false; }
  };
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getSnapshot: () => snapshot,
    load: async () => {
      if (loading || snapshot.loaded) return;
      loading = true;
      try { publish({ images: parseImageAnnotations(await getAnnotations(paperId, "image")), loaded: true, status: "已保存", error: null }); }
      catch (e) { publish({ error: `图片标注加载失败：${String(e)}`, status: "标注加载失败" }); }
      finally { loading = false; }
    },
    update: (key: string, marks: ImageMark[]) => {
      if (!snapshot.loaded) return;
      revision++;
      publish({ images: { ...snapshot.images, [key]: marks } });
      void save();
    },
    retry: save,
  };
}
const stores = new Map<string, ReturnType<typeof createImageAnnotationStore>>();
export function getImageAnnotationStore(paperId: string) {
  let store = stores.get(paperId);
  if (!store) { store = createImageAnnotationStore(paperId); stores.set(paperId, store); }
  return store;
}
