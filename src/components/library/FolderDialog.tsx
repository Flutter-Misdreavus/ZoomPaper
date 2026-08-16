import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { FOLDER_COLORS, folderColor } from "@/lib/folderColors";
import { createFolder, updateFolder, type Folder } from "@/lib/api";
import { Loader2, Tag, X } from "lucide-react";

export type FolderDialogState =
  | { mode: "create"; parentId?: string | null }
  | { mode: "edit"; folder: Folder };

interface Props {
  state: FolderDialogState | null;
  onOpenChange: (open: boolean) => void;
  /** 保存成功（创建或更新）后回调，父级负责刷新 */
  onSaved: () => void;
  onError: (msg: string) => void;
}

/**
 * 文件夹创建/编辑弹窗：名称 + 色板 + 标签 chips。
 */
export function FolderDialog({ state, onOpenChange, onSaved, onError }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("gray");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);

  const open = state !== null;
  const editing = state?.mode === "edit" ? state.folder : null;

  // 打开时回填
  useEffect(() => {
    if (!state) return;
    if (state.mode === "edit") {
      setName(state.folder.name);
      setColor(state.folder.color);
      setTags([...state.folder.tags]);
    } else {
      setName("");
      setColor("gray");
      setTags([]);
    }
    setTagInput("");
    setSaving(false);
  }, [state]);

  function addTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  }

  async function handleSave() {
    if (!state || saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      onError("文件夹名称不能为空");
      return;
    }
    setSaving(true);
    try {
      if (state.mode === "create") {
        await createFolder(trimmed, { parentId: state.parentId ?? null, color, tags });
      } else {
        await updateFolder(state.folder.id, { name: trimmed, color, tags });
      }
      onOpenChange(false);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <DialogPrimitive.Title className="font-heading text-base font-medium">
            {editing ? "编辑文件夹" : "新建文件夹"}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            设置文件夹名称、颜色与标签
          </DialogPrimitive.Description>

          <div className="mt-4 flex flex-col gap-4">
            {/* 名称 */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="folder-name">名称</Label>
              <Input
                id="folder-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：深度学习"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSave();
                }}
              />
            </div>

            {/* 颜色 */}
            <div className="flex flex-col gap-1.5">
              <Label>颜色</Label>
              <div className="flex flex-wrap gap-2">
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    title={c.label}
                    aria-label={`颜色：${c.label}`}
                    onClick={() => setColor(c.key)}
                    className={cn(
                      "pressable flex h-7 w-7 items-center justify-center rounded-full transition-transform",
                      color === c.key && "ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                    )}
                    style={{ backgroundColor: c.swatch }}
                  >
                    {color === c.key && (
                      <span className="h-2 w-2 rounded-full bg-white/90" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* 标签 */}
            <div className="flex flex-col gap-1.5">
              <Label>标签</Label>
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                  >
                    <Tag className="h-3 w-3 text-muted-foreground" />
                    {t}
                    <button
                      type="button"
                      aria-label={`删除标签 ${t}`}
                      className="pressable text-muted-foreground hover:text-foreground"
                      onClick={() => setTags(tags.filter((x) => x !== t))}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    } else if (e.key === "Backspace" && !tagInput && tags.length) {
                      setTags(tags.slice(0, -1));
                    }
                  }}
                  placeholder={tags.length ? "" : "输入标签后回车"}
                  className="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close render={<Button variant="outline" />} disabled={saving}>
              取消
            </DialogPrimitive.Close>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? "保存" : "创建"}
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 取文件夹当前颜色的小工具（色板兜底 gray） */
export function colorOf(folder: Folder): ReturnType<typeof folderColor> {
  return folderColor(folder.color);
}
