import { useEffect, useMemo, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FileText, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  commitReferenceImport,
  enrichReferenceImport,
  prepareReferenceImport,
  type Folder,
  type ReferenceImportAction,
  type ReferenceImportDecision,
  type ReferenceImportPreview,
  type ReferenceImportProgress,
  type ReferenceImportResult,
  type ReferencePreviewItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Step = "select" | "preview" | "importing" | "done";

interface Props {
  open: boolean;
  folders: Folder[];
  defaultFolderId?: string | null;
  onClose: () => void;
  onImported: (result: ReferenceImportResult) => void;
}

function folderPath(folder: Folder, folders: Folder[]): string {
  const parts = [folder.name];
  let parent = folder.parent_id;
  let guard = 0;
  while (parent && guard++ < 20) {
    const next = folders.find((item) => item.id === parent);
    if (!next) break;
    parts.unshift(next.name);
    parent = next.parent_id;
  }
  return parts.join(" / ");
}

function decisionFor(item: ReferencePreviewItem): ReferenceImportDecision {
  return {
    item_id: item.id,
    action: item.default_action,
    paper_id: item.existing?.paper_id ?? null,
    attachment_path: item.attachment?.path ?? null,
  };
}

export function ReferenceImportDialog({
  open: dialogOpen,
  folders,
  defaultFolderId = null,
  onClose,
  onImported,
}: Props) {
  const [step, setStep] = useState<Step>("select");
  const [sourcePath, setSourcePath] = useState("");
  const [attachmentsRoot, setAttachmentsRoot] = useState(
    () => localStorage.getItem("zoompaper.referenceAttachmentsRoot") ?? "",
  );
  const [targetFolderId, setTargetFolderId] = useState(defaultFolderId ?? "__none__");
  const [autoParse, setAutoParse] = useState(true);
  const [allowMetadataOnly, setAllowMetadataOnly] = useState(false);
  const [preview, setPreview] = useState<ReferenceImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ReferenceImportDecision>>({});
  const [progress, setProgress] = useState<ReferenceImportProgress | null>(null);
  const [result, setResult] = useState<ReferenceImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enriching, setEnriching] = useState(false);

  useEffect(() => {
    if (!dialogOpen) return;
    setStep("select");
    setSourcePath("");
    setTargetFolderId(defaultFolderId ?? "__none__");
    setPreview(null);
    setDecisions({});
    setProgress(null);
    setResult(null);
    setError(null);
    setAllowMetadataOnly(false);
    setBusy(false);
    setEnriching(false);
  }, [dialogOpen, defaultFolderId]);

  useEffect(() => {
    if (attachmentsRoot) {
      localStorage.setItem("zoompaper.referenceAttachmentsRoot", attachmentsRoot);
    } else {
      localStorage.removeItem("zoompaper.referenceAttachmentsRoot");
    }
  }, [attachmentsRoot]);

  const folderOptions = useMemo(
    () =>
      folders
        .map((folder) => ({ value: folder.id, label: folderPath(folder, folders) }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN")),
    [folders],
  );

  const stats = useMemo(() => {
    const items = preview?.items ?? [];
    let merge = 0;
    let create = 0;
    let skip = 0;
    for (const item of items) {
      const action = decisions[item.id]?.action ?? item.default_action;
      if (action === "merge") merge += 1;
      else if (action === "new") create += 1;
      else skip += 1;
    }
    return {
      merge,
      create,
      skip,
      noPdf: items.filter((item) => !item.attachment).length,
      duplicates: items.filter((item) => item.existing).length,
    };
  }, [preview, decisions]);

  async function chooseSource() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Zotero BibTeX / RIS", extensions: ["bib", "bibtex", "ris"] }],
    });
    if (typeof selected === "string") setSourcePath(selected);
  }

  async function chooseAttachmentsRoot() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setAttachmentsRoot(selected);
  }

  function progressChannel() {
    const channel = new Channel<ReferenceImportProgress>();
    channel.onmessage = (event) => setProgress(event);
    return channel;
  }

  async function prepare() {
    if (!sourcePath) {
      setError("请先选择 Zotero 导出的 .bib 或 .ris 文件");
      return;
    }
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const next = await prepareReferenceImport(
        sourcePath,
        attachmentsRoot || null,
        progressChannel(),
      );
      const initial: Record<string, ReferenceImportDecision> = {};
      for (const item of next.items) {
        const decision = decisionFor(item);
        if (allowMetadataOnly && !item.attachment && !item.existing) {
          decision.action = "new";
        }
        initial[item.id] = decision;
      }
      setPreview(next);
      setDecisions(initial);
      setStep("preview");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function setAction(item: ReferencePreviewItem, action: ReferenceImportAction) {
    setDecisions((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? decisionFor(item)),
        action,
        paper_id:
          action === "merge"
            ? current[item.id]?.paper_id ?? item.existing?.paper_id ?? null
            : null,
      },
    }));
  }

  function toggleMetadataOnly(checked: boolean) {
    setAllowMetadataOnly(checked);
    if (!checked) return;
    setDecisions((current) => {
      const next = { ...current };
      for (const item of preview?.items ?? []) {
        const decision = next[item.id] ?? decisionFor(item);
        if (!item.attachment && decision.action === "skip" && !item.existing) {
          next[item.id] = { ...decision, action: "new", paper_id: null };
        }
      }
      return next;
    });
  }

  async function chooseItemPdf(item: ReferencePreviewItem) {
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected !== "string") return;
    setDecisions((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? decisionFor(item)),
        attachment_path: selected,
      },
    }));
  }

  function applyRecommendations() {
    setDecisions((current) => {
      const next = { ...current };
      for (const item of preview?.items ?? []) {
        const decision = decisionFor(item);
        if (allowMetadataOnly && !item.attachment && !item.existing && decision.action === "skip") {
          decision.action = "new";
        }
        next[item.id] = decision;
      }
      return next;
    });
  }

  async function enrich() {
    if (!preview) return;
    const ids = preview.items
      .filter((item) => {
        const action = decisions[item.id]?.action ?? item.default_action;
        return action !== "skip" && (!item.record.doi || !item.record.year);
      })
      .map((item) => item.id);
    if (!ids.length) {
      setError("没有需要补全 DOI 的条目");
      return;
    }
    setEnriching(true);
    setError(null);
    try {
      const next = await enrichReferenceImport(preview.import_id, ids, progressChannel());
      setPreview(next);
      setDecisions((current) => {
        const updated = { ...current };
        for (const item of next.items) {
          updated[item.id] = {
            ...(updated[item.id] ?? decisionFor(item)),
            paper_id: item.existing?.paper_id ?? updated[item.id]?.paper_id ?? null,
          };
        }
        return updated;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setEnriching(false);
    }
  }

  async function commit() {
    if (!preview) return;
    const chosen = Object.values(decisions).filter((decision) => decision.action !== "skip");
    if (!chosen.length) {
      setError("请至少选择一条要导入的题录");
      return;
    }
    setBusy(true);
    setError(null);
    setStep("importing");
    try {
      const imported = await commitReferenceImport(
        preview.import_id,
        Object.values(decisions),
        targetFolderId === "__none__" ? null : targetFolderId,
        allowMetadataOnly,
        autoParse,
      );
      setResult(imported);
      setStep("done");
      onImported(imported);
    } catch (e) {
      setError(String(e));
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }

  const importing = step === "importing" || busy;

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(value) => {
        if (!value && !importing) onClose();
      }}
    >
      <DialogContent className="max-h-[88vh] max-w-5xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            从 Zotero 导入题录
          </DialogTitle>
          <DialogDescription>
            导入 BibTeX / RIS，匹配 PDF 附件并预览重复项。确认前不会写入论文库。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        {step === "select" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">题录文件</label>
              <div className="flex gap-2">
                <Input
                  aria-label="Zotero 题录文件"
                  readOnly
                  value={sourcePath}
                  placeholder="选择 .bib 或 .ris"
                  className="text-xs"
                />
                <Button type="button" variant="outline" onClick={() => void chooseSource()}>
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                  选择文件
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                附件根目录（可选，Zotero storage 或导出文件夹）
              </label>
              <div className="flex gap-2">
                <Input
                  aria-label="附件根目录"
                  readOnly
                  value={attachmentsRoot}
                  placeholder="不选择时只使用题录中的附件路径"
                  className="text-xs"
                />
                <Button type="button" variant="outline" onClick={() => void chooseAttachmentsRoot()}>
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                  选择目录
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">导入到文件夹</label>
                <Select
                  value={targetFolderId}
                  onValueChange={(value) => value !== null && setTargetFolderId(value)}
                >
                  <SelectTrigger aria-label="导入到文件夹" className="h-8">
                    <SelectValue>
                      {targetFolderId === "__none__"
                        ? "不加入文件夹"
                        : folderOptions.find((option) => option.value === targetFolderId)?.label ??
                          "不加入文件夹"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不加入文件夹</SelectItem>
                    {folderOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col justify-end gap-2 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoParse}
                    onChange={(event) => setAutoParse(event.target.checked)}
                  />
                  导入后自动解析有 PDF 的论文
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allowMetadataOnly}
                    onChange={(event) => toggleMetadataOnly(event.target.checked)}
                  />
                  允许仅导入题录（无 PDF）
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={importing}>
                取消
              </Button>
              <Button onClick={() => void prepare()} disabled={busy || !sourcePath}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                解析并预览
              </Button>
            </DialogFooter>
          </div>
        )}

        {(step === "preview" || step === "importing") && preview && (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{preview.format === "bibtex" ? "BibTeX" : "RIS"}</Badge>
              <span>共 {preview.total} 条</span>
              <span>合并 {stats.merge}</span>
              <span>新建 {stats.create}</span>
              <span>跳过 {stats.skip}</span>
              <span>无 PDF {stats.noPdf}</span>
              <span>疑似重复 {stats.duplicates}</span>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={allowMetadataOnly}
                  onChange={(event) => toggleMetadataOnly(event.target.checked)}
                  disabled={importing}
                />
                允许仅导入题录
              </label>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7"
                onClick={applyRecommendations}
                disabled={enriching || importing}
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                按推荐设置
              </Button>
            </div>
            {progress && (busy || enriching) && (
              <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                {progress.message}
                {progress.total > 0 ? `（${progress.completed}/${progress.total}）` : ""}
              </div>
            )}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {preview.items.map((item) => {
                const decision = decisions[item.id] ?? decisionFor(item);
                const canMerge = Boolean(item.existing) || decision.action === "merge";
                const selectedPdf = decision.attachment_path
                  ? decision.attachment_path.split(/[\\/]/).pop()
                  : item.attachment?.file_name;
                return (
                  <div key={item.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{item.record.title}</span>
                          {item.batch_duplicates.length > 0 && (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              同批重复 {item.batch_duplicates.length}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {[item.record.authors.slice(0, 3).join(", "), item.record.year, item.record.venue]
                            .filter(Boolean)
                            .join(" · ") || "无作者信息"}
                        </p>
                        {item.record.doi && (
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            DOI: {item.record.doi}
                          </p>
                        )}
                        <p className={cn("mt-1 text-[11px]", selectedPdf ? "text-muted-foreground" : "text-amber-600")}>
                          {selectedPdf ? `附件：${selectedPdf}` : "未匹配 PDF"}
                          {!selectedPdf || item.attachment_candidates.length > 0 ? (
                            <button
                              type="button"
                              className="ml-2 text-primary hover:underline"
                              onClick={() => void chooseItemPdf(item)}
                            >
                              选择 PDF
                            </button>
                          ) : null}
                        </p>
                        {item.existing && (
                          <p className="mt-1 text-[11px] text-amber-600">
                            与《{item.existing.title}》{item.existing.reason}
                            {item.existing.has_pdf ? "；保留原 PDF 与标注" : "；将补挂 PDF"}
                          </p>
                        )}
                        {item.issue && (
                          <p className="mt-1 text-[11px] text-amber-600">{item.issue}</p>
                        )}
                        {item.enrichment_error && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            补全：{item.enrichment_error}
                          </p>
                        )}
                      </div>
                      <select
                        aria-label={`${item.record.title} 导入方式`}
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                        value={decision.action}
                        disabled={importing || enriching}
                        onChange={(event) => setAction(item, event.target.value as ReferenceImportAction)}
                      >
                        <option value="merge" disabled={!canMerge}>
                          合并到现有论文
                        </option>
                        <option value="new">新建论文</option>
                        <option value="skip">跳过</option>
                      </select>
                    </div>
                    {decision.action === "new" && !selectedPdf && !allowMetadataOnly && (
                      <p className="mt-1 text-[11px] text-destructive">
                        无 PDF 且未允许仅导入题录，确认时会失败
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            {preview.errors.length > 0 && (
              <details className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">解析问题 {preview.errors.length} 条</summary>
                <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto">
                  {preview.errors.map((error, index) => (
                    <li key={`${error.index}-${index}`}>
                      #{error.index + 1} {error.key ?? ""}：{error.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <DialogFooter className="flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => setStep("select")}
                disabled={importing || enriching}
              >
                上一步
              </Button>
              <Button variant="outline" onClick={() => void enrich()} disabled={importing || enriching}>
                {enriching ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                联网补全 DOI
              </Button>
              <Button onClick={() => void commit()} disabled={importing || enriching || busy}>
                {step === "importing" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                确认导入
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
              导入完成
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-lg border border-border p-3">新建 {result.created}</div>
              <div className="rounded-lg border border-border p-3">合并 {result.merged}</div>
              <div className="rounded-lg border border-border p-3">跳过 {result.skipped}</div>
              <div className="rounded-lg border border-border p-3">失败 {result.failed}</div>
            </div>
            {result.warnings.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                {result.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </div>
            )}
            {result.failures.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                {result.failures.map((failure) => (
                  <p key={failure.item_id}>
                    {failure.title}：{failure.error}
                  </p>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button onClick={onClose}>完成</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
