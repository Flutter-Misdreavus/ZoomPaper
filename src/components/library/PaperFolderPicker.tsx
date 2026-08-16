import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import { buildFolderTree, type FolderNode } from "@/lib/folders";
import {
  addPapersToFolder,
  removePapersFromFolder,
  type Folder,
  type Paper,
} from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 选中的论文（可多篇，批量应用） */
  papers: Paper[];
  folders: Folder[];
  /** 任一归属变更成功后回调（父级刷新） */
  onChanged: () => void;
  onError: (msg: string) => void;
}

/**
 * 论文归属面板：列出全部文件夹（缩进展示层级），勾选 = 把选中论文加入，
 * 取消勾选 = 移除。多归属集合式语义，变更即时生效。
 */
export function PaperFolderPicker({ open, onOpenChange, papers, folders, onChanged, onError }: Props) {
  const [busy, setBusy] = useState(false);

  // 当前全部勾选 = 每篇论文都在该文件夹
  function checked(folderId: string): boolean {
    return papers.length > 0 && papers.every((p) => p.folder_ids.includes(folderId));
  }
  function indeterminate(folderId: string): boolean {
    return papers.some((p) => p.folder_ids.includes(folderId)) && !checked(folderId);
  }

  async function toggle(node: FolderNode) {
    if (busy) return;
    setBusy(true);
    const ids = papers.map((p) => p.id);
    const target = checked(node.folder.id);
    try {
      if (target) {
        await removePapersFromFolder(ids, node.folder.id);
      } else {
        await addPapersToFolder(ids, node.folder.id);
      }
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderNode(node: FolderNode, depth: number) {
    const c = folderColor(node.folder.color);
    const isChecked = checked(node.folder.id);
    return (
      <div key={node.folder.id}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle(node)}
          className={cn(
            "pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
            isChecked && "text-foreground"
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          <span
            className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
              isChecked
                ? "border-transparent text-white"
                : "border-input bg-background"
            )}
            style={isChecked ? { backgroundColor: c.swatch } : undefined}
          >
            {(isChecked || indeterminate(node.folder.id)) && (
              <Check className="h-3 w-3" strokeWidth={3} />
            )}
          </span>
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: c.swatch }}
          />
          <span className="truncate">{node.folder.name}</span>
        </button>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  const tree = buildFolderTree(folders);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <DialogPrimitive.Title className="font-heading text-base font-medium">
            添加到文件夹
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-muted-foreground">
            已选 {papers.length} 篇论文 · 勾选即加入，取消勾选即移出（多归属）
          </DialogPrimitive.Description>

          <div className="mt-3 max-h-72 overflow-y-auto pr-1">
            {tree.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有文件夹，先在左侧新建一个吧
              </p>
            ) : (
              tree.map((node) => renderNode(node, 0))
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <DialogPrimitive.Close render={<Button variant="outline" />}>
              完成
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
