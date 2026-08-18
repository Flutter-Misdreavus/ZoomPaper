import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/MarkdownView";
import { HighlightNotePopover } from "@/components/HighlightNotePopover";
import { SelectionToolbar, HIGHLIGHT_COLORS } from "@/components/SelectionToolbar";
import { generateBlog, type Paper } from "@/lib/api";
import { loadTextHighlights, saveTextHighlights } from "@/lib/annotations";
import { applyMarks, type TextHighlight } from "@/lib/textAnnotate";
import { useTextSelection, type PendingSelection } from "@/lib/useTextSelection";
import { copyTextToClipboard } from "@/lib/utils";
import {
  ANALYSIS_TAGS,
  parseBlog,
  type AnalysisKey,
  type ParsedBlog,
} from "@/lib/blog";
import {
  FileText,
  List,
  Loader2,
  RefreshCw,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";

interface Props {
  paper: Paper;
  /** 生成成功后回写 blog_md_path，让外层 paper 状态保持最新 */
  onBlogGenerated: (path: string) => void;
  /** 划选「提问」：选中文字 + 来源位置（如「博客·洞见」） */
  onAskSelection?: (text: string, location: string) => void;
}

/** docKey → 人类可读来源位置（AI 工具 / 引用区展示用） */
function labelFor(docKey: string): string {
  const m = /^blog:analysis:(.+)$/.exec(docKey);
  if (m) {
    const tag = ANALYSIS_TAGS.find((t) => t.key === m[1]);
    return `博客·${tag?.label ?? m[1]}`;
  }
  return "博客正文";
}

export function BlogPanel({ paper, onBlogGenerated, onAskSelection }: Props) {
  const [blog, setBlog] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedBlog | null>(null);
  const [activeKey, setActiveKey] = useState<AnalysisKey>("task");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- 划选高亮 / 笔记（与 PDF 阅读一致） ----
  const [highlights, setHighlights] = useState<TextHighlight[]>([]);
  const [highlightsLoaded, setHighlightsLoaded] = useState(false);
  const [sel, setSel] = useState<(PendingSelection & { docKey: string }) | null>(null);
  const [noteEditor, setNoteEditor] = useState<{
    hl: TextHighlight;
    x: number;
    y: number;
  } | null>(null);
  const [showList, setShowList] = useState(false);
  /** 内容容器（元素 → docKey）：剖析区（当前 Tab）+ 博客正文 */
  const containersRef = useRef(new Map<HTMLElement, string>());

  // 已有博客：经 asset 协议读回 blog.md
  useEffect(() => {
    if (!paper.blog_md_path) return;
    let cancelled = false;
    setLoading(true);
    fetch(convertFileSrc(paper.blog_md_path))
      .then((r) => {
        if (!r.ok) throw new Error(`读取博客失败（${r.status}）`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) {
          setBlog(text);
          setParsed(parseBlog(text));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paper.blog_md_path]);

  // 加载 / 保存博客标注（blog_annotations.json）
  useEffect(() => {
    let cancelled = false;
    loadTextHighlights(paper.id, "blog")
      .then((hs) => {
        if (cancelled) return;
        setHighlights(hs);
        setHighlightsLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paper.id]);
  useEffect(() => {
    if (!highlightsLoaded) return;
    void saveTextHighlights(paper.id, "blog", highlights);
  }, [highlights, highlightsLoaded, paper.id]);

  // 划选监听：定位到所属容器并映射偏移
  useTextSelection(containersRef, (docKey, pending) => setSel({ ...pending, docKey }));

  // 内容渲染后重绘高亮（幂等：先解包再按当前列表重包）
  useLayoutEffect(() => {
    for (const [el, docKey] of containersRef.current) {
      applyMarks(el, highlights.filter((h) => h.docKey === docKey));
    }
  }, [blog, activeKey, highlights]);

  // 点击正文高亮 → 打开笔记编辑
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const mark = (e.target as HTMLElement).closest?.(
        "mark.zp-text-highlight",
      ) as HTMLElement | null;
      if (!mark) return;
      const hl = highlights.find((h) => h.id === mark.dataset.hlId);
      if (!hl) return;
      const r = mark.getBoundingClientRect();
      setNoteEditor({ hl, x: r.left, y: r.bottom + 8 });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [highlights]);

  // 浮动工具条：选区清空或滚动时收起
  useEffect(() => {
    if (!sel) return;
    const hide = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setSel(null);
    };
    const onScroll = () => setSel(null);
    document.addEventListener("selectionchange", hide);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("selectionchange", hide);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [sel]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const md = await generateBlog(paper.id);
      setBlog(md);
      setParsed(parseBlog(md));
      // blog.md 落盘在 paper.md 同级目录，与后端保持一致
      const blogPath = paper.md_path.replace(/[^/\\]+$/, "blog.md");
      onBlogGenerated(blogPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  /** 注册内容容器（callback ref；元素变化时更新 docKey 映射） */
  function registerContainer(el: HTMLElement | null, docKey: string) {
    if (!el) return;
    containersRef.current.delete(el);
    containersRef.current.set(el, docKey);
  }

  function addHighlight(color: string, openNote: boolean) {
    if (!sel) return;
    const hl: TextHighlight = {
      id: crypto.randomUUID(),
      docKey: sel.docKey,
      label: labelFor(sel.docKey),
      start: sel.start,
      end: sel.end,
      text: sel.text,
      color,
      note: null,
      created_at: Date.now(),
    };
    setHighlights((prev) => [...prev, hl]);
    const pos = { x: sel.x, y: sel.y };
    setSel(null);
    window.getSelection()?.removeAllRanges();
    if (openNote) setNoteEditor({ hl, x: pos.x, y: pos.y + 44 });
  }

  function askSelection() {
    if (!sel) return;
    onAskSelection?.(sel.text, labelFor(sel.docKey));
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }

  function saveNote(text: string) {
    if (!noteEditor) return;
    const trimmed = text.trim();
    setHighlights((prev) =>
      prev.map((h) =>
        h.id === noteEditor.hl.id
          ? { ...h, note: trimmed ? { text: trimmed, updated_at: Date.now() } : null }
          : h,
      ),
    );
    setNoteEditor(null);
  }

  function deleteHighlight(id: string) {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
  }

  /** 列表点击：滚动到正文对应高亮（仅当该 docKey 当前已渲染时有效） */
  function jumpToHighlight(id: string) {
    document
      .querySelector(`mark.zp-text-highlight[data-hl-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // 论文目录：博客与 paper.md 同目录，相对图片路径（images/...）以此为基准解析
  const baseDir = paper.md_path.replace(/[^/\\]+$/, "").replace(/[\\/]+$/, "");

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  const sections = parsed?.sections ?? null;
  const activeText = (sections && sections[activeKey]) || null;
  const sortedHighlights = [...highlights].sort(
    (a, b) => b.created_at - a.created_at,
  );

  return (
    <div className="relative flex flex-col gap-5">
      {/* 操作区 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={handleGenerate} disabled={generating} size="sm">
          {generating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : blog ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {generating ? "生成中…" : blog ? "重新生成" : "生成博客"}
        </Button>
        {blog && (
          <Button
            variant={showList ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setShowList((v) => !v)}
            title="博客标注列表"
          >
            <List className="h-3.5 w-3.5" />
            <span className="ml-1">注释{highlights.length ? ` ${highlights.length}` : ""}</span>
          </Button>
        )}
        {blog && !sections && (
          <span className="text-xs text-muted-foreground">
            该博客由旧版本生成，缺少深度剖析，可点击「重新生成」
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {showList && (
        <div className="max-h-64 overflow-y-auto rounded-lg border bg-card px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              注释（{highlights.length}）
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => setShowList(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          {sortedHighlights.length === 0 ? (
            <p className="px-1 pb-1 text-xs text-muted-foreground">
              暂无标注。划选文字后点「高亮」或「笔记」即可添加。
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {sortedHighlights.map((hl) => (
                <div
                  key={hl.id}
                  className="group -mx-1 flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/60"
                  onClick={() => jumpToHighlight(hl.id)}
                >
                  <span
                    className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: hl.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        {hl.label}
                      </span>
                      {hl.note && (
                        <span className="text-[11px] text-primary">· 有笔记</span>
                      )}
                    </div>
                    <p className="line-clamp-2 text-xs leading-snug text-foreground/85">
                      {hl.text}
                    </p>
                  </div>
                  <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      title="编辑笔记"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNoteEditor({ hl, x: e.clientX, y: e.clientY + 8 });
                      }}
                    >
                      <StickyNote className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-destructive"
                      title="删除高亮"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteHighlight(hl.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {generating && !blog ? (
        <div className="flex flex-col gap-3 pt-2">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : blog ? (
        <>
          {/* 深度剖析窗口：上方 Tab 标签，下方对应维度内容 */}
          {sections && (
            <div className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
              <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
                <span className="mr-1 text-sm font-semibold">深度剖析</span>
                <div className="inline-flex rounded-lg bg-muted p-[3px]">
                  {ANALYSIS_TAGS.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setActiveKey(t.key)}
                      className={`pressable rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                        activeKey === t.key
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div
                className="min-h-0 p-4"
                ref={(el) => registerContainer(el, `blog:analysis:${activeKey}`)}
              >
                {activeText ? (
                  <MarkdownView markdown={activeText} baseDir={baseDir} />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    该部分内容缺失，可点击「重新生成」获取
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 博客正文 */}
          <div
            className="flex flex-col gap-2 border-t pt-5"
            ref={(el) => registerContainer(el, "blog:body")}
          >
            <h2 className="text-base font-semibold">博客正文</h2>
            <MarkdownView markdown={parsed?.body ?? blog} baseDir={baseDir} />
          </div>
        </>
      ) : (
        !error && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
            <FileText className="h-10 w-10" />
            <p className="text-sm">还没有博客，点击「生成博客」即可获得科普版正文与深度剖析</p>
          </div>
        )
      )}

      {/* 划选浮动工具条 */}
      {sel && (
        <SelectionToolbar
          x={sel.x}
          y={sel.y}
          onHighlight={(color) => addHighlight(color, false)}
          onNote={() => addHighlight(HIGHLIGHT_COLORS[0].color, true)}
          onAsk={onAskSelection ? askSelection : undefined}
          onCopy={() => void copyTextToClipboard(sel.text)}
        />
      )}

      {/* 高亮笔记编辑弹层 */}
      {noteEditor && (
        <HighlightNotePopover
          x={noteEditor.x}
          y={noteEditor.y}
          initial={noteEditor.hl.note?.text ?? ""}
          onSave={saveNote}
          onCancel={() => setNoteEditor(null)}
          onDelete={() => deleteHighlight(noteEditor.hl.id)}
        />
      )}
    </div>
  );
}
