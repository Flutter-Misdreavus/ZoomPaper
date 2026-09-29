import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import {
  addPaperToPlan,
  addPapersToFolder,
  createReadingPlan,
  deleteFolder,
  deletePaper,
  emptyTrash,
  exportNotes,
  importPdf,
  listFolders,
  listPapers,
  listReadingPlans,
  parsePdf,
  permanentlyDeletePaper,
  removePaperFromPlan,
  removePapersFromFolder,
  renamePaper,
  restorePaper,
  setPaperStarred,
  setPaperStatus,
  updateFolder,
  type Folder,
  type Paper,
  type ParseProgress,
  type ReadingPlan,
  type ReadingStatus,
} from "@/lib/api";
import type { LibraryView } from "@/lib/folders";
import { parseProgressPercent } from "@/lib/utils";
import { usePaperSelection } from "@/hooks/usePaperSelection";
import { useDragPaperSelection } from "@/hooks/useDragPaperSelection";
import { FolderSidebar } from "@/components/library/FolderSidebar";
import { TopBar, type LibraryLayout, type SortBy } from "@/components/library/TopBar";
import type { PaperFilter } from "@/components/library/FilterBar";
import { BulkBar } from "@/components/library/BulkBar";
import { PaperCard } from "@/components/library/PaperCard";
import { PaperGrid } from "@/components/library/PaperGrid";
import { FolderDialog, type FolderDialogState } from "@/components/library/FolderDialog";
import { PaperFolderPicker } from "@/components/library/PaperFolderPicker";
import { PaperTable } from "@/components/library/PaperTable";
import { PaperInspector } from "@/components/library/PaperInspector";
import { TrashList } from "@/components/library/TrashList";

type Renaming = { kind: "folder"; id: string } | { kind: "paper"; id: string };

interface Props {
  onOpenPaper: (id: string) => void;
  refreshSignal?: number;
}

export function Library({ onOpenPaper, refreshSignal = 0 }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [plans, setPlans] = useState<ReadingPlan[]>([]);
  const [customDateTarget, setCustomDateTarget] = useState<{
    paper: Paper;
    planId: string | null;
  } | null>(null);
  const [customDate, setCustomDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<Paper | null>(null);
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);

  const [view, setView] = useState<LibraryView>({ type: "all" });
  const [filter, setFilter] = useState<PaperFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>(() => {
    const saved = localStorage.getItem("zoompaper.librarySort");
    return saved === "title" || saved === "read" ? saved : "created";
  });
  const [layout, setLayout] = useState<LibraryLayout>(() =>
    localStorage.getItem("zoompaper.libraryLayout") === "grid" ? "grid" : "list",
  );
  const [focusedPaperId, setFocusedPaperId] = useState<string | null>(null);
  const { selected, toggle, setSelectedState, clear, selectAll, isSelected, size: selectedSize } = usePaperSelection();
  const selectionDrag = useDragPaperSelection(setSelectedState);
  const [selectionMode, setSelectionMode] = useState(false);
  const suppressBlankExitUntil = useRef(0);
  const exitSelection = () => { clear(); setSelectionMode(false); };
  const enterSelection = (id: string) => {
    suppressBlankExitUntil.current = Date.now() + 900;
    setSelectionMode(true);
    if (!selected.has(id)) toggle(id);
  };
  const [notice, setNotice] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPaperIds, setPickerPaperIds] = useState<string[]>([]);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<Folder | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<Paper[] | null>(null);

  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [parseProgress, setParseProgress] = useState<Record<string, ParseProgress>>({});
  const updateParseProgress = (id: string, progress: ParseProgress) => {
    setParseProgress((prev) => ({ ...prev, [id]: progress }));
    setNotice(`解析中 · ${Math.round(parseProgressPercent(progress))}%`);
  };
  const handleMetadataTranslated = useCallback((updated: Paper) => {
    setPapers((current) => current.map((paper) => paper.id === updated.id ? updated : paper));
  }, []);
  const clearParseProgress = (id: string) => setParseProgress((prev) => { const next = { ...prev }; delete next[id]; return next; });

  const refresh = useCallback(async () => {
    try {
      const [ps, fs, pls] = await Promise.all([listPapers(), listFolders(), listReadingPlans()]);
      setPapers(ps);
      setFolders(fs);
      setPlans(pls);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  useEffect(() => {
    localStorage.setItem("zoompaper.librarySort", sortBy);
  }, [sortBy]);

  useEffect(() => {
    localStorage.setItem("zoompaper.libraryLayout", layout);
  }, [layout]);

  // ---------- 视图内论文（文件夹 × 状态过滤 × 关键词 交集 + 排序，星标置顶） ----------

  const visiblePapers = useMemo(() => {
    const activePapers = papers.filter((paper) => paper.deleted_at == null);
    let list = view.type === "trash"
      ? papers.filter((paper) => paper.deleted_at != null)
      : activePapers;
    if (view.type === "folder") {
      list = activePapers.filter((p) => p.folder_ids.includes(view.folderId));
    } else if (view.type === "starred") {
      list = activePapers.filter((p) => p.starred);
    } else if (view.type === "uncategorized") {
      list = activePapers.filter((p) => p.folder_ids.length === 0);
    }
    if (view.type !== "trash") {
      if (filter === "unread") list = list.filter((p) => p.reading_status === "unread");
      else if (filter === "reading") list = list.filter((p) => p.reading_status === "reading");
      else if (filter === "read") list = list.filter((p) => p.reading_status === "read");
      else if (filter === "starred") list = list.filter((p) => p.starred);
    }

    // 多关键词过滤：标题、期刊/会议、作者与摘要均可检索，关键词取交集。
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      list = list.filter((p) => {
        const haystack = `${p.title} ${p.venue ?? ""} ${p.authors ?? ""} ${p.abstract ?? ""}`.toLocaleLowerCase();
        return words.every((word) => haystack.includes(word));
      });
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
    if (view.type === "trash") return sorted;
    const starred = sorted.filter((p) => p.starred);
    const rest = sorted.filter((p) => !p.starred);
    return [...starred, ...rest];
  }, [papers, view, filter, query, sortBy]);

  const selectedPapers = useMemo(
    () => papers.filter((p) => selected.has(p.id)),
    [papers, selected]
  );
  const focusedPaper = papers.find((paper) => paper.id === focusedPaperId) ?? null;

  useEffect(() => {
    if (focusedPaperId && !visiblePapers.some((paper) => paper.id === focusedPaperId)) {
      setFocusedPaperId(null);
    }
  }, [focusedPaperId, visiblePapers]);
  // 归属弹窗只保存稳定的 id，并始终从最新 papers 派生对象。否则刷新后弹窗仍会
  // 持有旧 folder_ids，造成后端已加入文件夹、勾选状态却不更新。
  const pickerPapers = useMemo(() => {
    const ids = new Set(pickerPaperIds);
    return papers.filter((paper) => ids.has(paper.id));
  }, [papers, pickerPaperIds]);

  const isFolderView = view.type === "folder";
  const activeFolder = isFolderView ? folders.find((f) => f.id === view.folderId) : undefined;
  const currentFolderId = isFolderView ? view.folderId : null;
  const title = isFolderView
    ? (activeFolder?.name ?? "论文库")
    : view.type === "starred"
      ? "收藏"
    : view.type === "uncategorized"
      ? "未分类"
    : view.type === "trash"
      ? "回收站"
      : "论文库";
  const continuePaper = useMemo(
    () => [...papers]
      .filter((paper) => paper.deleted_at == null && paper.last_read_at != null)
      .sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0))[0] ?? null,
    [papers]
  );

  // ---------- 视图 / 过滤切换：清空选择（自动退出选择模式） ----------

  function handleSelectView(v: LibraryView) {
    setView(v);
    exitSelection();
  }

  function handleFilterChange(v: PaperFilter) {
    setFilter(v);
    exitSelection();
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
      exitSelection();
    } catch (e) {
      setError(String(e));
      await refresh();
    }
  }

  // ---------- 阅读计划（提醒事项式快捷加入/定日期） ----------

  async function refreshPlans() {
    try {
      setPlans(await listReadingPlans());
    } catch {
      /* 静默：不阻塞论文库主流程 */
    }
  }

  /** 快捷加入/更新日期：planId 为 null 时自动新建一个指派计划 */
  async function handlePlanQuickAdd(paper: Paper, planId: string | null, dueTs: number | null) {
    try {
      if (planId) {
        await addPaperToPlan(planId, paper.id, dueTs);
      } else {
        await createReadingPlan("papers", {
          paperIds: [paper.id],
          deadline: dueTs ?? undefined,
        });
      }
      await refreshPlans();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handlePlanRemove(paper: Paper, planId: string) {
    try {
      await removePaperFromPlan(planId, paper.id);
      await refreshPlans();
    } catch (e) {
      setError(String(e));
    }
  }

  function handlePlanCustomDate(paper: Paper, planId: string | null) {
    setCustomDate("");
    setCustomDateTarget({ paper, planId });
  }

  /** 自定义日期浮层确认：date 串（YYYY-MM-DD）或 null（无日期） */
  async function commitCustomDate(date: string | null) {
    const target = customDateTarget;
    setCustomDateTarget(null);
    if (!target) return;
    const ts = date
      ? Math.floor(new Date(`${date}T23:59:59`).getTime() / 1000)
      : null;
    await handlePlanQuickAdd(target.paper, target.planId, ts);
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
    const files = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!files) return;
    const paths = typeof files === "string" ? [files] : files;

    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const failures: string[] = [];
      for (const [index, file] of paths.entries()) {
        setNotice(`正在导入 ${index + 1} / ${paths.length}`);
        try {
          const paper = await importPdf(file);
          if (currentFolderId) await addPapersToFolder([paper.id], currentFolderId);
          setParsingId(paper.id);
          setNotice(`正在解析并建立索引 ${index + 1} / ${paths.length}`);
          try {
            await parsePdf(paper.id, (progress) => updateParseProgress(paper.id, progress));
          } catch (e) {
            failures.push(`${paper.title}：已导入，解析失败（${e}）`);
          } finally { clearParseProgress(paper.id); }
        } catch (e) {
          failures.push(`${file.split(/[\\/]/).pop() ?? file}：${e}`);
        }
      }
      await refresh();
      setNotice(`已处理 ${paths.length} 个文件${failures.length ? `，${failures.length} 项需要处理` : ""}`);
      if (failures.length) setError(failures.join("\n"));
    } catch (e) {
      setError(`导入失败：${e}`);
    } finally {
      setImporting(false);
      setParsingId(null);
    }
  }

  async function handleExportNotes() {
    const paper = selectedPapers[0];
    if (selectedPapers.length !== 1 || !paper) return;
    const safeTitle = paper.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    const destination = await save({
      defaultPath: `${safeTitle}-笔记.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destination) return;
    try {
      await exportNotes(paper.id, destination);
      setNotice("阅读笔记已导出");
      exitSelection();
    } catch (e) {
      setError(`导出失败：${e}`);
    }
  }

  async function handleParse(paperId: string) {
    setParsingId(paperId);
    setError(null);
    try {
      await parsePdf(paperId, (progress) => updateParseProgress(paperId, progress));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setParsingId(null);
      clearParseProgress(paperId);
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
      exitSelection();
      setDeleteTargets(null);
      await refresh();
    } catch (e) {
      setError(`删除失败：${e}`);
    } finally {
      setDeleting(false);
    }
  }

  async function handleRestorePaper(paper: Paper) {
    try {
      await restorePaper(paper.id);
      await refresh();
    } catch (e) {
      setError(`恢复失败：${e}`);
    }
  }

  async function handlePermanentDelete() {
    if (!permanentDeleteTarget) return;
    setDeleting(true);
    try {
      await permanentlyDeletePaper(permanentDeleteTarget.id);
      setPermanentDeleteTarget(null);
      await refresh();
    } catch (e) {
      setError(`永久删除失败：${e}`);
    } finally {
      setDeleting(false);
    }
  }

  async function handleEmptyTrash() {
    setDeleting(true);
    try {
      await emptyTrash();
      setEmptyTrashConfirm(false);
      await refresh();
    } catch (e) {
      setError(`清空回收站失败：${e}`);
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
      exitSelection();
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
    setPickerPaperIds(targets.map((target) => target.id));
    setPickerOpen(true);
  }

  function handleBulkPickFolder() {
    setPickerPaperIds(selectedPapers.map((paper) => paper.id));
    setPickerOpen(true);
  }

  async function handleRemoveFromCurrentFolder(paper: Paper) {
    if (!currentFolderId) return;
    try {
      await removePapersFromFolder([paper.id], currentFolderId);
      exitSelection();
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
      } else if (e.key === "Escape" && selectionMode) {
        exitSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectionMode(true);
        selectAll(visiblePapers.map((paper) => paper.id));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [renaming, folderDialog, deleteTargets, pickerOpen, selectedSize, selectedPapers, selectionMode, clear, selectAll, visiblePapers]);

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
          filter={filter}
          onFilterChange={handleFilterChange}
          layout={layout}
          onLayoutChange={setLayout}
          selectionMode={selectionMode}
          onToggleSelectionMode={() => selectionMode ? exitSelection() : setSelectionMode(true)}
          trashMode={view.type === "trash"}
          onEmptyTrash={papers.some((paper) => paper.deleted_at != null) ? () => setEmptyTrashConfirm(true) : undefined}
        />

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
        {continuePaper && selectedSize === 0 && layout === "grid" && (
          <button
            type="button"
            onClick={() => onOpenPaper(continuePaper.id)}
            className="pressable mx-4 mt-3 flex items-center justify-between rounded-xl border border-zp-border bg-white px-4 py-2.5 text-left shadow-sm transition-colors hover:bg-zp-surface-hover dark:bg-zp-surface"
          >
            <span className="min-w-0">
              <span className="block text-[11px] font-medium tracking-wide text-zp-quaternary">继续上次阅读</span>
              <span className="block truncate text-sm font-medium text-zp-primary">{continuePaper.title}</span>
            </span>
            <span className="ml-4 shrink-0 text-xs text-zp-tertiary">继续阅读 →</span>
          </button>
        )}

        {/* 批量操作栏：选中 ≥1 篇时浮现（入场/退场动画） */}
        <AnimatePresence>
          {selectedSize > 0 && (
            <BulkBar
              count={selectedSize}
              onMarkRead={() => void handleBulkSetStatus("read")}
              onSetStatus={(s) => void handleBulkSetStatus(s)}
              onPickFolder={handleBulkPickFolder}
              onExport={() => void handleExportNotes()}
              onDelete={() => setDeleteTargets(selectedPapers)}
              onClose={exitSelection}
            />
          )}
        </AnimatePresence>

        <div
          className={`min-h-0 flex-1 overflow-auto ${layout === "grid" ? "px-4 py-4" : "bg-white dark:bg-zp-surface"}`}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("[data-paper-item], button, a, input, textarea, select, [role='menuitem']")) return;
            if (selectionMode) {
              if (selectionDrag.shouldSuppressClick()) return;
              if (Date.now() < suppressBlankExitUntil.current) return;
              exitSelection();
              return;
            }
            if (focusedPaperId) setFocusedPaperId(null);
          }}
        >
          {error && (
            <div className="m-3 whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {notice && !error && (
            <div className="m-3 rounded-md border border-zp-border bg-white px-4 py-3 text-sm text-zp-secondary dark:bg-zp-surface">
              {notice}
            </div>
          )}

          {loading ? (
            <div className={layout === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4" : "space-y-px p-2"}>
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className={layout === "grid" ? "h-32 w-full rounded-[10px]" : "h-10 w-full rounded"} />
              ))}
            </div>
          ) : visiblePapers.length === 0 ? (
            query.trim() || filter !== "all"
              ? <div className="py-24 text-center text-sm text-zp-quaternary">没有匹配的论文</div>
              : <div className="h-full" aria-label="空论文列表" />
          ) : view.type === "trash" ? (
            <TrashList papers={visiblePapers} onRestore={(paper) => void handleRestorePaper(paper)} onDelete={setPermanentDeleteTarget} />
          ) : layout === "list" ? (
            <PaperTable
              papers={visiblePapers}
              folders={folders}
              plans={plans}
              selectedIds={selected}
              selectionMode={selectionMode}
              onLongPress={enterSelection}
              focusedId={focusedPaperId}
              currentFolderId={currentFolderId}
              parsingId={parsingId}
              onFocus={(paper) => setFocusedPaperId(paper.id)}
              onToggle={toggle}
              onSelectionDragStart={selectionDrag.start}
              onSelectionDragEnter={selectionDrag.enter}
              onOpen={onOpenPaper}
              onRename={(paper) => setRenaming({ kind: "paper", id: paper.id })}
              renamingId={renaming?.kind === "paper" ? renaming.id : null}
              onCommitRename={handleCommitPaperRename}
              onCancelRename={() => setRenaming(null)}
              onPickFolder={handlePickFolder}
              onSetStatus={(paper, status) => void handleSetStatus(paper, status)}
              onBulkSetStatus={(status) => void handleBulkSetStatus(status)}
              onBulkDelete={() => setDeleteTargets(selectedPapers)}
              onPlanQuickAdd={(paper, planId, due) => void handlePlanQuickAdd(paper, planId, due)}
              onPlanRemove={(paper, planId) => void handlePlanRemove(paper, planId)}
              onPlanCustomDate={handlePlanCustomDate}
              onToggleStar={(paper) => void handleToggleStar(paper)}
              onParse={handleParse}
              onDelete={(paper) => setDeleteTargets([paper])}
              onRemoveFromCurrentFolder={handleRemoveFromCurrentFolder}
            />
          ) : (
            <PaperGrid>
              {visiblePapers.map((paper) => (
                <PaperCard
                  key={paper.id}
                  paper={paper}
                  folders={folders}
                  selected={isSelected(paper.id)}
                  selectedIds={selected}
                  selectionMode={selectionMode}
                  onLongPress={enterSelection}
                  isRenaming={renaming?.kind === "paper" && renaming.id === paper.id}
                  parsing={parsingId === paper.id}
                  progress={parseProgress[paper.id] ?? null}
                  currentFolderId={currentFolderId}
                  onToggle={toggle}
                  onSelectionDragStart={selectionDrag.start}
                  onSelectionDragEnter={selectionDrag.enter}
                  onOpen={onOpenPaper}
                  onStartRename={(p) => setRenaming({ kind: "paper", id: p.id })}
                  onCommitRename={handleCommitPaperRename}
                  onCancelRename={() => setRenaming(null)}
                  onPickFolder={handlePickFolder}
                  onSetStatus={(p, s) => void handleSetStatus(p, s)}
                  onBulkSetStatus={(status) => void handleBulkSetStatus(status)}
                  onBulkDelete={() => setDeleteTargets(selectedPapers)}
                  plans={plans}
                  onPlanQuickAdd={(p, planId, due) => void handlePlanQuickAdd(p, planId, due)}
                  onPlanRemove={(p, planId) => void handlePlanRemove(p, planId)}
                  onPlanCustomDate={handlePlanCustomDate}
                  onToggleStar={(p) => void handleToggleStar(p)}
                  onJumpToFolder={(folderId) => {
                    setView({ type: "folder", folderId });
                    exitSelection();
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
          {layout === "list" && focusedPaper && !selectionMode && (
            <PaperInspector
              paper={focusedPaper}
              folders={folders}
              onClose={() => setFocusedPaperId(null)}
              onOpen={() => onOpenPaper(focusedPaper.id)}
              onToggleStar={() => void handleToggleStar(focusedPaper)}
              onPickFolder={() => handlePickFolder(focusedPaper)}
              onParse={() => handleParse(focusedPaper.id)}
              onTranslated={handleMetadataTranslated}
            />
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
        onChanged={async () => {
          await refresh();
          if (selectionMode) exitSelection();
        }}
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
            <AlertDialogTitle>移到回收站</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargets && deleteTargets.length > 1
                ? `将选中的 ${deleteTargets.length} 篇论文移到回收站？`
                : `将《${deleteTargets?.[0]?.title ?? ""}》移到回收站？`}
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
              移到回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={permanentDeleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setPermanentDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>永久删除论文</AlertDialogTitle><AlertDialogDescription>将永久删除《{permanentDeleteTarget?.title ?? ""}》及其本地文件和相关数据。此操作无法撤销。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void handlePermanentDelete()}>{deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}永久删除</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={emptyTrashConfirm} onOpenChange={(open) => { if (!deleting) setEmptyTrashConfirm(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>清空回收站</AlertDialogTitle><AlertDialogDescription>回收站中的论文、本地文件、解析结果和相关会话将被永久删除。此操作无法撤销。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void handleEmptyTrash()}>{deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}清空</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 自定义截止日期（阅读计划快捷加入） */}
      <AlertDialog
        open={customDateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCustomDateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>自定义截止日期</AlertDialogTitle>
            <AlertDialogDescription className="line-clamp-2">
              《{customDateTarget?.paper.title}》
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            type="date"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => void commitCustomDate(null)}
            >
              无日期
            </AlertDialogAction>
            <AlertDialogAction
              disabled={!customDate}
              onClick={() => void commitCustomDate(customDate)}
            >
              确定
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
