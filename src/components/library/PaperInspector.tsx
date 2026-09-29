import { useEffect, useRef, useState } from "react";
import { BookOpen, FolderInput, GripVertical, Loader2, Sparkles, Star, X } from "lucide-react";
import { translatePaperMetadata, type Folder, type Paper } from "@/lib/api";
import { cn, displayPaperTitle, formatDuration, formatTime } from "@/lib/utils";
import { IconTooltip } from "@/components/ui/icon-tooltip";

const WIDTH_KEY = "zoompaper.paperInspectorWidth";
const LANGUAGE_KEY = "zoompaper.paperInspectorLanguage";

interface Props {
  paper: Paper;
  folders: Folder[];
  onClose: () => void;
  onOpen: () => void;
  onToggleStar: () => void;
  onPickFolder: () => void;
  onParse: () => void;
  onTranslated: (paper: Paper) => void;
}

function clampWidth(value: number) {
  const maximum = Math.max(300, Math.min(560, window.innerWidth - 560));
  return Math.min(maximum, Math.max(260, value));
}

export function PaperInspector({ paper, folders, onClose, onOpen, onToggleStar, onPickFolder, onParse, onTranslated }: Props) {
  const [width, setWidth] = useState(() => clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 320));
  const resizeRef = useRef<{ x: number; width: number } | null>(null);
  const [language, setLanguage] = useState<"original" | "zh">(() => localStorage.getItem(LANGUAGE_KEY) === "zh" ? "zh" : "original");
  const [previewPaper, setPreviewPaper] = useState(paper);
  const [translating, setTranslating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);

  useEffect(() => setPreviewPaper(paper), [paper]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      setWidth(clampWidth(resize.width + resize.x - event.clientX));
    };
    const stop = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  }, [width]);

  useEffect(() => {
    if (language !== "zh" || paper.parse_status !== "ready") return;
    if (paper.title_zh && (!paper.abstract || paper.abstract_zh)) return;
    let cancelled = false;
    setTranslating(true);
    setTranslationError(null);
    void translatePaperMetadata(paper.id)
      .then((updated) => {
        if (cancelled) return;
        setPreviewPaper(updated);
        onTranslated(updated);
      })
      .catch((error) => {
        if (!cancelled) setTranslationError(String(error));
      })
      .finally(() => {
        if (!cancelled) setTranslating(false);
      });
    return () => { cancelled = true; };
  }, [language, onTranslated, paper.abstract, paper.abstract_zh, paper.id, paper.parse_status, paper.title_zh]);

  const names = previewPaper.folder_ids.map((id) => folders.find((folder) => folder.id === id)?.name).filter(Boolean);
  const translated = language === "zh";
  const shownTitle = translated && previewPaper.title_zh ? previewPaper.title_zh : previewPaper.title;
  const shownAbstract = translated && previewPaper.abstract_zh ? previewPaper.abstract_zh : previewPaper.abstract;

  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col border-l border-zp-border bg-[#fbfbfa] dark:bg-[#191919]">
      <button
        type="button"
        aria-label="调整论文预览宽度"
        title="拖动调整宽度"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          resizeRef.current = { x: event.clientX, width };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none"
      >
        <span className="absolute left-1/2 top-1/2 flex h-9 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-zp-border bg-white text-zp-quaternary opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 dark:bg-zp-surface">
          <GripVertical className="h-3 w-3" />
        </span>
      </button>

      <div className="flex h-12 items-center justify-between gap-2 px-4">
        <span className="shrink-0 text-xs font-medium text-zp-quaternary">论文信息</span>
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-md bg-zp-surface p-0.5 text-[11px]">
            <button type="button" onClick={() => { setLanguage("original"); localStorage.setItem(LANGUAGE_KEY, "original"); }} className={cn("rounded px-2 py-1", language === "original" ? "bg-white text-zp-primary shadow-sm dark:bg-zp-surface-hover" : "text-zp-tertiary")}>原文</button>
            <button type="button" onClick={() => { setLanguage("zh"); localStorage.setItem(LANGUAGE_KEY, "zh"); }} title={translationError ?? undefined} className={cn("flex items-center gap-1 rounded px-2 py-1", language === "zh" ? "bg-white text-zp-primary shadow-sm dark:bg-zp-surface-hover" : "text-zp-tertiary")}>中文{translating && <Loader2 className="h-3 w-3 animate-spin" />}</button>
          </div>
          <IconTooltip label="关闭详情" side="bottom"><button type="button" aria-label="关闭详情" onClick={onClose} className="rounded-md p-1 text-zp-quaternary hover:bg-zp-surface-hover hover:text-zp-primary"><X className="h-4 w-4" /></button></IconTooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        <h2 className="text-[15px] leading-6 font-semibold text-zp-primary">{displayPaperTitle(shownTitle)}</h2>
        {previewPaper.venue && <p className="mt-2 text-xs leading-5 text-zp-secondary">{previewPaper.venue}</p>}

        <div className="mt-4 flex items-center gap-1">
          <IconTooltip label="打开论文"><button type="button" onClick={onOpen} aria-label="打开论文" className="flex h-8 w-8 items-center justify-center rounded-md bg-zp-primary text-white"><BookOpen className="h-4 w-4" /></button></IconTooltip>
          <IconTooltip label={previewPaper.starred ? "取消星标" : "添加星标"}><button type="button" onClick={onToggleStar} aria-label={previewPaper.starred ? "取消星标" : "添加星标"} className={cn("flex h-8 w-8 items-center justify-center rounded-md hover:bg-zp-surface-hover", previewPaper.starred ? "text-amber-500" : "text-zp-quaternary")}><Star className={cn("h-4 w-4", previewPaper.starred && "fill-current")} /></button></IconTooltip>
          <IconTooltip label="加入文件夹"><button type="button" onClick={onPickFolder} aria-label="加入文件夹" className="flex h-8 w-8 items-center justify-center rounded-md text-zp-quaternary hover:bg-zp-surface-hover hover:text-zp-primary"><FolderInput className="h-4 w-4" /></button></IconTooltip>
          <IconTooltip label="解析论文"><button type="button" onClick={onParse} aria-label="解析论文" className="flex h-8 w-8 items-center justify-center rounded-md text-zp-quaternary hover:bg-zp-surface-hover hover:text-zp-primary"><Sparkles className="h-4 w-4" /></button></IconTooltip>
        </div>

        <dl className="mt-5 grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-zp-quaternary">状态</dt><dd className="text-zp-secondary">{{ unread: "未读", reading: "在读", read: "已读" }[previewPaper.reading_status] ?? "未读"}</dd>
          <dt className="text-zp-quaternary">解析</dt><dd className="text-zp-secondary">{{ ready: "已解析", parsing: "解析中", failed: "解析失败", unparsed: "未解析" }[previewPaper.parse_status] ?? "未解析"}</dd>
          <dt className="text-zp-quaternary">阅读时长</dt><dd className="text-zp-secondary">{formatDuration(previewPaper.total_read_seconds)}</dd>
          <dt className="text-zp-quaternary">最后阅读</dt><dd className="text-zp-secondary">{previewPaper.last_read_at ? formatTime(previewPaper.last_read_at) : "—"}</dd>
          <dt className="text-zp-quaternary">文件夹</dt><dd className="text-zp-secondary">{names.join("、") || "未分类"}</dd>
        </dl>

        {shownAbstract && <div className="mt-6"><h3 className="mb-2 text-xs font-medium text-zp-primary">摘要</h3><p className="text-xs leading-5 text-zp-secondary">{shownAbstract}</p></div>}
      </div>
    </aside>
  );
}
