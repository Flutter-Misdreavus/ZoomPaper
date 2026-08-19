import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence } from "motion/react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Loader2 } from "lucide-react";
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
  setPaperStarred,
  setPaperStatus,
  updateFolder,
  type Folder,
  type Paper,
  type ReadingStatus,
} from "@/lib/api";
import type { LibraryView } from "@/lib/folders";
import { usePaperSelection } from "@/hooks/usePaperSelection";
import { FolderSidebar } from "@/components/library/FolderSidebar";
import { TopBar, type SortBy } from "@/components/library/TopBar";
import { FilterBar, type PaperFilter } from "@/components/library/FilterBar";
import { BulkBar } from "@/components/library/BulkBar";
import { PaperCard } from "@/components/library/PaperCard";
import { PaperGrid } from "@/components/library/PaperGrid";
import { FolderDialog, type FolderDialogState } from "@/components/library/FolderDialog";
import { PaperFolderPicker } from "@/components/library/PaperFolderPicker";

type Renaming = { kind: "folder"; id: string } | { kind: "paper"; id: string };

interface Props {
  onOpenPaper: (id: string) => void;
}

export function Library({ onOpenPaper }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<LibraryView>({ type: "all" });
  const [filter, setFilter] = useState<PaperFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>("created");
  const { selected, toggle, clear, isSelected, size: selectedSize } = usePaperSelection();

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

  // ---------- 视图内论文（文件夹 × 状态过滤 × 关键词 交集 + 排序，星标置顶） ----------

  const visiblePapers = useMemo(() => {
    let list = papers;
    if (view.type === "folder") {
      list = papers.filter((p) => p.folder_ids.includes(view.folderId));
    } else if (view.type === "uncategorized") {
      list = papers.filter((p) => p.folder_ids.length === 0);
    }
    if (filter === "unread") list = list.filter((p) => p.reading_status === "unread");
    else if (filter === "reading") list = list.filter((p) => p.reading_status === "reading");
    else if (filter === "read") list = list.filter((p) => p.reading_status === "read");
    else if (filter === "starred") list = list.filter((p) => p.starred);

    // 关键词过滤：标题/作者子串，忽略大小写
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.authors ?? "").toLowerCase().includes(q)
      );
    }

    const sorted = [...list];
    if (sortBy === "title") {
      sorted.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
    } else if (sortBy === "read") {
      sorted.sort((a, b) => (b.last_read_at ?? -1) - (a.last_read_at ?? -1));
    } else {
      sorted.sort((a, b) => b.created_at - a.created_at);
    }
    // 星标置顶：稳定分区（sort 稳定，分区后星标组内保持当前排序键的相对顺序）
    const starred = sorted.filter((p) => p.starred);
    const rest = sorted.filter((p) => !p.starred);
    return [...starred, ...rest];
  }, [papers, view, filter, query, sortBy]);

  const selectedPapers = useMemo(
    () => papers.filter((p) => selected.has(p.id)),
    [papers, selected]
  );

  const isFolderView = view.type === "folder";
  const activeFolder = isFolderView ? folders.find((f) => f.id === view.folderId) : undefined;
  const currentFolderId = isFolderView ? view.folderId : null;
  const title = isFolderView
    ? (activeFolder?.name ?? "论文库")
    : view.type === "uncategorized"
      ? "未分类"
      : "论文库";

  // ---------- 视图 / 过滤切换：清空选择（自动退出选择模式） ----------

  function handleSelectView(v: LibraryView) {
    setView(v);
    clear();
  }

  function handleFilterChange(v: PaperFilter) {
    setFilter(v);
    clear();
  }

  // ---------- 阅读状态 / 星标（乐观更新） ----------

  async function handleSetStatus(paper: Paper, status: ReadingStatus) {
    const prev = paper;
    setPapers((ps) =>
      ps.map((p) => (p.id === paper.id ? { ...p, reading_status: status } : p))
    );
    try {
      await setPaperStatus(paper.id, status);
    } catch (e) {
      setPapers((ps) => ps.map((p) => (p.id === paper.id ? prev : p)));
      setError(String(e));
    }
  }

  async function handleBulkSetStatus(status: ReadingStatus) {
    const targets = selectedPapers;
    if (targets.length === 0) return;
    const ids = new Set(targets.map((p) => p.id));
    setPapers((ps) =>
      ps.map((p) => (ids.has(p.id) ? { ...p, reading_status: status } : p))
    );
    try {
      await Promise.all(targets.map((p) => setPaperStatus(p.id, status)));
    } catch (e) {
      setError(String(e));
      await refresh();
    }
  }

  async function handleToggleStar(paper: Paper) {
    const next = !paper.starred;
    setPapers((ps) =>
      ps.map((p) => (p.id === paper.id ? { ...p, starred: next } : p))
    );
    try {
      await setPaperStarred(paper.id, next);
    } catch (e) {
      setPapers((ps) => ps.map((p) => (p.id === paper.id ? paper : p)));
      setError(String(e));
    }
  }

  // ---------- 导入 / 解析 / 删除 ----------

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
      clear();
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

  // ---------- 归属面板 / 移除 ----------

  /** 打开归属面板。目标集合 = 当前多选（若目标论文在其中）；否则仅该论文。 */
  function handlePickFolder(paper: Paper) {
    const targets =
      selected.has(paper.id) && selected.size > 0
        ? papers.filter((p) => selected.has(p.id))
        : [paper];
    setPickerPapers(targets);
    setPickerOpen(true);
  }

  function handleBulkPickFolder() {
    setPickerPapers(selectedPapers);
    setPickerOpen(true);
  }

  async function handleRemoveFromCurrentFolder(paper: Paper) {
    if (!currentFolderId) return;
    try {
      await removePapersFromFolder([paper.id], currentFolderId);
      clear();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // ---------- 键盘 ----------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [role='menu'], [role='dialog']")) return;
      if (renaming || folderDialog || deleteTargets || pickerOpen) return;
      if (e.key === "Delete" && selectedSize > 0) {
        e.preventDefault();
        setDeleteTargets(selectedPapers);
      } else if (e.key === "Escape" && selectedSize > 0) {
        clear();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [renaming, folderDialog, deleteTargets, pickerOpen, selectedSize, selectedPapers, clear]);

  // ---------- 渲染 ----------

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <FolderSidebar
        folders={folders}
        papers={papers}
        view={view}
        onSelectView={handleSelectView}
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

      <div className="flex min-w-0 flex-1 flex-col bg-zp-surface">
        <TopBar
          title={title}
          count={visiblePapers.length}
          sortBy={sortBy}
          onSortChange={setSortBy}
          query={query}
          onQueryChange={setQuery}
          onImport={() => void handleImport()}
          importing={importing}
        />

        <FilterBar value={filter} onChange={handleFilterChange} />

        {/* 批量操作栏：选中 ≥1 篇时浮现（入场/退场动画） */}
        <AnimatePresence>
          {selectedSize > 0 && (
            <BulkBar
              count={selectedSize}
              onMarkRead={() => void handleBulkSetStatus("read")}
              onSetStatus={(s) => void handleBulkSetStatus(s)}
              onPickFolder={handleBulkPickFolder}
              onDelete={() => setDeleteTargets(selectedPapers)}
              onClose={clear}
            />
          )}
        </AnimatePresence>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full rounded-[10px]" />
              ))}
            </div>
          ) : visiblePapers.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <FileText className="h-10 w-10" />
                {query.trim() ? (
                  <p>没有匹配「{query.trim()}」的论文</p>
                ) : filter !== "all" ? (
                  <p>没有符合条件的论文</p>
                ) : view.type === "uncategorized" ? (
                  <p>没有未分类的论文，拖拽论文到侧栏文件夹完成归类</p>
                ) : isFolderView ? (
                  <p>这个文件夹还是空的，把论文拖进来或右键添加</p>
                ) : (
                  <p>还没有论文，点击「导入论文」开始</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <PaperGrid>
              {visiblePapers.map((paper) => (
                <PaperCard
                  key={paper.id}
                  paper={paper}
                  folders={folders}
                  selected={isSelected(paper.id)}
                  selectedIds={selected}
                  selectionMode={selectedSize > 0}
                  isRenaming={renaming?.kind === "paper" && renaming.id === paper.id}
                  parsing={parsingId === paper.id}
                  currentFolderId={currentFolderId}
                  onToggle={toggle}
                  onOpen={onOpenPaper}
                  onStartRename={(p) => setRenaming({ kind: "paper", id: p.id })}
                  onCommitRename={handleCommitPaperRename}
                  onCancelRename={() => setRenaming(null)}
                  onPickFolder={handlePickFolder}
                  onSetStatus={(p, s) => void handleSetStatus(p, s)}
                  onToggleStar={(p) => void handleToggleStar(p)}
                  onJumpToFolder={(folderId) => {
                    setView({ type: "folder", folderId });
                    clear();
                  }}
                  onParse={handleParse}
                  onDelete={(p) => setDeleteTargets([p])}
                  onRemoveFromCurrentFolder={handleRemoveFromCurrentFolder}
                />
              ))}
            </PaperGrid>
          )}
        </div>
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
