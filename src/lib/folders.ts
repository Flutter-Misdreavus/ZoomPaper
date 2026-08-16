/**
 * 文件夹树与统计辅助：扁平 folders → 树、计数、面包屑、子树 id。
 */
import type { Folder, Paper } from "./api";

/** 论文库内容区视图：全部 / 未分类 / 某文件夹 */
export type LibraryView =
  | { type: "all" }
  | { type: "uncategorized" }
  | { type: "folder"; folderId: string };

/** 拖拽论文时写入 dataTransfer 的 MIME 类型（JSON: paperIds[]） */
export const PAPER_DRAG_MIME = "application/x-zoompaper-papers";

/** 从拖拽事件读回论文 id 列表（无则空数组）。 */
export function readDragPaperIds(dt: DataTransfer): string[] {
  const raw = dt.getData(PAPER_DRAG_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export interface FolderNode {
  folder: Folder;
  children: FolderNode[];
}

/** 扁平文件夹列表 → 树（顶级 → 子树），同级按名称排序。 */
export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f.id, { folder: f, children: [] });

  const roots: FolderNode[] = [];
  for (const f of folders) {
    const node = byId.get(f.id)!;
    const parent = f.parent_id ? byId.get(f.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortByName = (nodes: FolderNode[]) =>
    nodes.sort((a, b) => a.folder.name.localeCompare(b.folder.name, "zh-Hans-CN"));
  const sortRec = (nodes: FolderNode[]) => {
    sortByName(nodes);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** 某文件夹的直接归属论文数（不含子文件夹）。 */
export function folderPaperCount(papers: Paper[], folderId: string): number {
  return papers.filter((p) => p.folder_ids.includes(folderId)).length;
}

/** 未分类论文（无任何归属）。 */
export function uncategorizedPapers(papers: Paper[]): Paper[] {
  return papers.filter((p) => p.folder_ids.length === 0);
}

/** 面包屑：从根到目标文件夹的祖先链（含自身）。 */
export function folderPath(folders: Folder[], folderId: string): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  let cur = byId.get(folderId);
  while (cur) {
    path.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return path;
}

/** 以某文件夹为根的完整子树 id 集合（含自身）。 */
export function folderSubtreeIds(folders: Folder[], folderId: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parent_id) {
      const arr = byParent.get(f.parent_id) ?? [];
      arr.push(f.id);
      byParent.set(f.parent_id, arr);
    }
  }
  const out = new Set<string>([folderId]);
  const stack = [folderId];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()!) ?? []) {
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}
