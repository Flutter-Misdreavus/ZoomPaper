import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronRight,
  FileText,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import {
  addPapersToFolder,
  deleteFolder,
  deletePaper,
  importPdf,
  listFolders,
  listPapers,
  parsePdf,
  removePapersFromFolder,
  renamePaper,
  updateFolder,
  type Folder,
  type Paper,
} from "@/lib/api";
import { folderPath, type LibraryView } from "@/lib/folders";
import { folderColor } from "@/lib/folderColors";
import { LibrarySidebar } from "@/components/library/LibrarySidebar";
import { PaperCard } from "@/components/library/PaperCard";
import { PaperGridItem } from "@/components/library/PaperGridItem";
import { FolderDialog, type FolderDialogState } from "@/components/library/FolderDialog";
import { PaperFolderPicker } from "@/components/library/PaperFolderPicker";

type SortBy = "created" | "title" | "read";
type ViewMode = "list" | "grid";
type Renaming = { kind: "folder"; id: string } | { kind: "paper"; id: string };

interface Props {
  onOpenPaper: (id: string) => void;
}

const SORT_LABELS: Record<SortBy, string> = {
  created: "最近导入",
  title: "标题",
  read: "最近阅读",
};

export function Library({ onOpenPaper }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<LibraryView>({ type: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortBy, setSortBy] = useState<SortBy>("created");

  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPapers, setPickerPapers] = useState<Paper[]>([]);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<Folder | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<Paper[] | null>(null);

  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ps, fs] = await Promise.all([listPapers(), listFolders()]);
      setPapers(ps);
      setFolders(fs);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------- 视图内论文（过滤 + 排序） ----------

  const visiblePapers = useMemo(() => {
    let list = papers;
    if (view.type === "folder") {
      list = papers.filter((p) => p.folder_ids.includes(view.folderId));
    } else if (view.type === "uncategorized") {
      list = papers.filter((p) => p.folder_ids.length === 0);
    }
    const sorted = [...list];
    if (sortBy === "title") {
      sorted.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
    } else if (sortBy === "read") {
      sorted.sort((a, b) => (b.last_read_at ?? -1) - (a.last_read_at ?? -1));
    } else {
      sorted.sort((a, b) => b.created_at - a.created_at);
    }
    return sorted;
  }, [papers, view, sortBy]);

  const selectedPapers = useMemo(
    () => papers.filter((p) => selected.has(p.id)),
    [papers, selected]
  );

  const currentFolderId = view.type === "folder" ? view.folderId : null;
  const breadcrumb = view.type === "folder" ? folderPath(folders, view.folderId) : [];

  // ---------- 导入 / 解析 / 删除（沿用原有流程） ----------

  async function handleImport() {
    const file = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof file !== "string") return;

    setImporting(true);
    setError(null);
    try {
      const paper = await importPdf(file);
      setParsingId(paper.id);
      try {
        await parsePdf(paper.id);
      } catch (e) {
        setError(`导入成功，但解析失败：${e}`);
      }
      await refresh();
    } catch (e) {
      setError(`导入失败：${e}`);
    } finally {
      setImporting(false);
      setParsingId(null);
    }
  }

  async function handleParse(paperId: string) {
    setParsingId(paperId);
    setError(null);
    try {
      await parsePdf(paperId);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setParsingId(null);
    }
  }

  async function handleDeletePapers() {
    if (!deleteTargets?.length) return;
    setDeleting(true);
    setError(null);
    try {
      for (const p of deleteTargets) {
        await deletePaper(p.id);
      }
      setSelected(new Set());
      setDeleteTargets(null);
      await refresh();
    } catch (e) {
      setError(`删除失败：${e}`);
    } finally {
      setDeleting(false);
    }
  }

  // ---------- 文件夹操作 ----------

  function handleCreateFolder(parentId: string) {
    setFolderDialog({
      mode: "create",
      parentId: parentId === "__root__" ? null : parentId,
    });
  }

  async function handleDeleteFolder() {
    if (!deleteFolderTarget) return;
    try {
      await deleteFolder(deleteFolderTarget.id);
      if (view.type === "folder" && view.folderId === deleteFolderTarget.id) {
        setView({ type: "all" });
      }
      setDeleteFolderTarget(null);
      await refresh();
    } catch (e) {
      setError(`删除文件夹失败：${e}`);
    }
  }

  // ---------- 拖拽投放 ----------

  async function handleDropPapers(paperIds: string[], folderId: string | null) {
    setError(null);
    // 乐观更新本地状态，命令失败再回滚刷新
    const prev = papers;
    const apply = (ps: Paper[]): Paper[] =>
      ps.map((p) => {
        if (!paperIds.includes(p.id)) return p;
        const set = new Set(p.folder_ids);
        if (folderId === null) set.clear();
        else set.add(folderId);
        return { ...p, folder_ids: [...set] };
      });
    setPapers(apply(prev));
    try {
      if (folderId === null) {
        // 未分类 = 从所有文件夹移除归属（按目标文件夹分组批量调用）
        const byFolder = new Map<string, string[]>();
        for (const pid of paperIds) {
          const p = prev.find((x) => x.id === pid);
          for (const fid of p?.folder_ids ?? []) {
            const arr = byFolder.get(fid) ?? [];
            arr.push(pid);
            byFolder.set(fid, arr);
          }
        }
        for (const [fid, ids] of byFolder) {
          await removePapersFromFolder(ids, fid);
        }
      } else {
        await addPapersToFolder(paperIds, folderId);
      }
      await refresh();
    } catch (e) {
      setPapers(prev);
      setError(String(e));
    }
  }

  // ---------- 重命名 ----------

  async function handleCommitPaperRename(paper: Paper, title: string) {
    setRenaming(null);
    try {
      const updated = await renamePaper(paper.id, title);
      setPapers((ps) => ps.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleCommitFolderRename(folder: Folder, name: string) {
    setRenaming(null);
    try {
      const updated = await updateFolder(folder.id, { name });
      setFolders((fs) => fs.map((f) => (f.id === updated.id ? updated : f)));
    } catch (e) {
      setError(String(e));
    }
  }

  // ---------- 选择 / 键盘 ----------

  function handleSelect(paperId: string, additive: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (additive) {
        if (next.has(paperId)) next.delete(paperId);
        else next.add(paperId);
      } else {
        next.clear();
        next.add(paperId);
      }
      return next;
    });
  }

  /**
   * 打开归属面板。目标集合 = 当前多选（若目标论文在其中）；否则仅该论文。
   * 这样右键 / 「⋯」菜单的目标论文即使未选中也能直接操作。
   */
  function handlePickFolder(paper: Paper) {
    const targets =
      selected.has(paper.id) && selected.size > 0
        ? papers.filter((p) => selected.has(p.id))
        : [paper];
    setPickerPapers(targets);
    setPickerOpen(true);
  }

  async function handleRemoveFromCurrentFolder(paper: Paper) {
    if (!currentFolderId) return;
    try {
      await removePapersFromFolder([paper.id], currentFolderId);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(paper.id);
        return next;
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [role='menu'], [role='dialog']")) return;
      if (renaming || folderDialog || deleteTargets || pickerOpen) return;
      if (e.key === "Delete" && selected.size > 0) {
        e.preventDefault();
        setDeleteTargets(selectedPapers);
      } else if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [renaming, folderDialog, deleteTargets, pickerOpen, selected.size, selectedPapers]);

  // ---------- 渲染 ----------

  const isFolderView = view.type === "folder";
  const activeFolder = isFolderView ? folders.find((f) => f.id === view.folderId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      <LibrarySidebar
        folders={folders}
        papers={papers}
        view={view}
        onSelectView={(v) => {
          setView(v);
          setSelected(new Set());
        }}
        expanded={expanded}
        onToggleExpand={(id) =>
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        renaming={renaming?.kind === "folder" ? renaming : null}
        onStartRename={(folder) => setRenaming({ kind: "folder", id: folder.id })}
        onCommitRename={handleCommitFolderRename}
        onCancelRename={() => setRenaming(null)}
        onCreateSubfolder={handleCreateFolder}
        onEditFolder={(folder) => setFolderDialog({ mode: "edit", folder })}
        onDeleteFolder={(folder) => setDeleteFolderTarget(folder)}
        onDropPapers={(ids, fid) => void handleDropPapers(ids, fid)}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        {/* 页头：标题 / 面包屑 + 工具栏 */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {isFolderView && breadcrumb.length > 1 ? (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <button
                  type="button"
                  className="pressable hover:text-foreground"
                  onClick={() => {
                    setView({ type: "all" });
                    setSelected(new Set());
                  }}
                >
                  全部论文
                </button>
                {breadcrumb.slice(1).map((f) => (
                  <span key={f.id} className="flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5" />
                    <button
                      type="button"
                      className="pressable hover:text-foreground"
                      onClick={() => {
                        setView({ type: "folder", folderId: f.id });
                        setSelected(new Set());
                      }}
                    >
                      {f.name}
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <h1 className="text-2xl font-bold tracking-tight">
                {view.type === "uncategorized" ? "未分类" : "论文库"}
              </h1>
            )}
            {activeFolder && (
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: folderColor(activeFolder.color).swatch }}
                />
                <p className="text-sm text-muted-foreground">
                  当前文件夹共 {visiblePapers.length} 篇论文
                </p>
                {activeFolder.tags.length > 0 && (
                  <div className="flex items-center gap-1">
                    {activeFolder.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!isFolderView && (
              <p className="text-sm text-muted-foreground">
                本地优先的论文阅读与知识管理
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* 视图切换 */}
            <div className="flex items-center rounded-md border bg-background p-0.5">
              <button
                type="button"
                title="列表视图"
                aria-label="列表视图"
                onClick={() => setViewMode("list")}
                className={`pressable rounded-[5px] p-1.5 transition-colors ${
                  viewMode === "list" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <List className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="网格视图"
                aria-label="网格视图"
                onClick={() => setViewMode("grid")}
                className={`pressable rounded-[5px] p-1.5 transition-colors ${
                  viewMode === "grid" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>

            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
              <SelectTrigger className="h-9 w-32" aria-label="排序方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SORT_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button onClick={handleImport} disabled={importing}>
              {importing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              导入论文
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* 多选操作条 */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-lg border bg-accent/60 px-3 py-2 text-sm">
            <span className="font-medium">已选 {selected.size} 篇</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPickerPapers(selectedPapers);
                setPickerOpen(true);
              }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加到文件夹…
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteTargets(selectedPapers)}
            >
              删除
            </Button>
            <button
              type="button"
              className="pressable ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelected(new Set())}
            >
              <X className="h-3.5 w-3.5" />
              取消选择
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : visiblePapers.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <FileText className="h-10 w-10" />
              {view.type === "uncategorized" ? (
                <p>没有未分类的论文，拖拽论文到侧栏文件夹完成归类</p>
              ) : isFolderView ? (
                <p>这个文件夹还是空的，把论文拖进来或右键添加</p>
              ) : (
                <p>还没有论文，点击「导入论文」开始</p>
              )}
            </CardContent>
          </Card>
        ) : viewMode === "list" ? (
          <div className="flex flex-col gap-3">
            {visiblePapers.map((paper) => (
              <PaperCard
                key={paper.id}
                paper={paper}
                folders={folders}
                selected={selected.has(paper.id)}
                selectedIds={selected}
                isRenaming={renaming?.kind === "paper" && renaming.id === paper.id}
                parsing={parsingId === paper.id}
                currentFolderId={currentFolderId}
                onSelect={handleSelect}
                onOpen={onOpenPaper}
                onStartRename={(p) => setRenaming({ kind: "paper", id: p.id })}
                onCommitRename={handleCommitPaperRename}
                onCancelRename={() => setRenaming(null)}
                onPickFolder={handlePickFolder}
                onParse={handleParse}
                onDelete={(p) => setDeleteTargets([p])}
                onRemoveFromCurrentFolder={handleRemoveFromCurrentFolder}
                onJumpToFolder={(folderId) => {
                  setView({ type: "folder", folderId });
                  setSelected(new Set());
                }}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {visiblePapers.map((paper) => (
              <PaperGridItem
                key={paper.id}
                paper={paper}
                folders={folders}
                selected={selected.has(paper.id)}
                selectedIds={selected}
                isRenaming={renaming?.kind === "paper" && renaming.id === paper.id}
                currentFolderId={currentFolderId}
                onSelect={handleSelect}
                onOpen={onOpenPaper}
                onStartRename={(p) => setRenaming({ kind: "paper", id: p.id })}
                onCommitRename={handleCommitPaperRename}
                onCancelRename={() => setRenaming(null)}
                onPickFolder={handlePickFolder}
                onDelete={(p) => setDeleteTargets([p])}
                onRemoveFromCurrentFolder={handleRemoveFromCurrentFolder}
                onJumpToFolder={(folderId) => {
                  setView({ type: "folder", folderId });
                  setSelected(new Set());
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 新建 / 编辑文件夹弹窗 */}
      <FolderDialog
        state={folderDialog}
        onOpenChange={(open) => {
          if (!open) setFolderDialog(null);
        }}
        onSaved={() => void refresh()}
        onError={setError}
      />

      {/* 论文归属面板 */}
      <PaperFolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        papers={pickerPapers}
        folders={folders}
        onChanged={() => void refresh()}
        onError={setError}
      />

      {/* 删除论文确认 */}
      <AlertDialog
        open={deleteTargets !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTargets(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除论文</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargets && deleteTargets.length > 1
                ? `确定删除选中的 ${deleteTargets.length} 篇论文吗？将同时删除本地 PDF、解析结果、AI 博客、向量索引和相关问答会话，此操作不可恢复。`
                : `确定删除《${deleteTargets?.[0]?.title ?? ""}》吗？将同时删除本地 PDF、解析结果、AI 博客、向量索引和相关问答会话，此操作不可恢复。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDeletePapers()}
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除文件夹确认 */}
      <AlertDialog
        open={deleteFolderTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除文件夹</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除文件夹「{deleteFolderTarget?.name}」吗？其中的论文
              <strong>不会</strong>被删除（将变为未分类），子文件夹会上移一级。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void handleDeleteFolder()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
