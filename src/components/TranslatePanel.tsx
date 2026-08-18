import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/MarkdownView";
import { HighlightNotePopover } from "@/components/HighlightNotePopover";
import { SelectionToolbar, HIGHLIGHT_COLORS } from "@/components/SelectionToolbar";
import {
  getPaperMd,
  getTranslation,
  saveTranslation,
  translateChunk,
  type TranslationChunk,
} from "@/lib/api";
import { loadTextHighlights, saveTextHighlights } from "@/lib/annotations";
import { applyMarks, type TextHighlight } from "@/lib/textAnnotate";
import { useTextSelection, type PendingSelection } from "@/lib/useTextSelection";
import { copyTextToClipboard } from "@/lib/utils";
import {
  buildZhDoc,
  chunkMarkdown,
  pairChunks,
  splitReferences,
  stripStandaloneImagesAndMath,
} from "@/lib/translate";
import {
  buildHeadingTree,
  extractHeadingEntries,
  type TocEntry,
} from "@/lib/outline";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Languages,
  List,
  ListTree,
  Loader2,
  RefreshCw,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";

type Mode = "en" | "zh" | "bi";

const MODES: { value: Mode; label: string }[] = [
  { value: "en", label: "纯英文" },
  { value: "zh", label: "纯中文" },
  { value: "bi", label: "对照" },
];

interface Props {
  paperId: string;
  /** 划选「提问」：选中文字 + 来源位置（如「译文·第 5 段」） */
  onAskSelection?: (text: string, location: string) => void;
}

/** docKey → 人类可读来源位置（AI 工具 / 引用区展示用） */
function labelFor(docKey: string): string {
  const bi = /^trans:bi:(\d+)$/.exec(docKey);
  if (bi) return `译文·第 ${Number(bi[1]) + 1} 段`;
  if (docKey === "trans:bi:refs") return "译文·参考文献";
  if (docKey.startsWith("trans:bi:rest:")) return "译文·未对齐段";
  if (docKey.startsWith("trans:bi:zrest:")) return "译文·未对齐段（多余译文）";
  if (docKey === "trans:en") return "译文·纯英";
  if (docKey === "trans:zh") return "译文·纯中";
  return "译文";
}

/**
 * AI 翻译：把论文 paper.md 正文分块译成中文（参考文献不翻译、不进 LLM 省 token），
 * 本地缓存为 translation.json（带版本号）。纯英 = 完整原文；纯中 = 正文译文 + 末尾英文原版
 * 参考文献；对照 = 正文按段落逐段配对（英文段黑色 + 中文段浅蓝色）+ 末尾英文原版参考文献；
 * 未配对的英文段（无中文译文）与多余中文段（多余译文）均完整展示并加徽标，绝不静默丢弃。
 *
 * 目录：扫描渲染后 DOM 的 h1–h6 构建 MacDown 风格大纲（对照模式跳过 .trans-zh 中文段标题，
 * 避免重复条目），点击平滑滚动 + 高亮闪烁，滚动时当前章节跟随高亮。
 *
 * 划选：三种模式内容均可划选高亮 / 笔记 / 提问，标注按 docKey 分别定位
 * （纯英 trans:en、纯中 trans:zh、对照逐段 trans:bi:<i> 等），持久化到 translation_annotations.json。
 */
export function TranslatePanel({ paperId, onAskSelection }: Props) {
  const [mode, setMode] = useState<Mode>("en");
  const [enMd, setEnMd] = useState<string | null>(null);
  const [chunks, setChunks] = useState<TranslationChunk[] | null>(null);
  const [loadingEn, setLoadingEn] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
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
  /** 内容容器（元素 → docKey）：纯英 / 纯中 / 对照逐段 */
  const containersRef = useRef(new Map<HTMLElement, string>());

  // 目录状态
  const [showToc, setShowToc] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<TocEntry>>(new Set());
  const [activeEntry, setActiveEntry] = useState<TocEntry | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const flatEntriesRef = useRef<TocEntry[]>([]);
  const rafRef = useRef<number | null>(null);

  // 英文原文切成「正文 + 参考文献」：参考文献不翻译、不进 LLM，译文末尾附英文原版
  const { body, references } = useMemo(() => splitReferences(enMd ?? ""), [enMd]);

  // 加载英文原文 + 翻译缓存
  useEffect(() => {
    let cancelled = false;
    setLoadingEn(true);
    setError(null);
    Promise.all([getPaperMd(paperId), getTranslation(paperId)])
      .then(([md, t]) => {
        if (cancelled) return;
        setEnMd(md);
        setChunks(t);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingEn(false));
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  // 加载 / 保存译文标注（translation_annotations.json）
  useEffect(() => {
    let cancelled = false;
    loadTextHighlights(paperId, "translate")
      .then((hs) => {
        if (cancelled) return;
        setHighlights(hs);
        setHighlightsLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paperId]);
  useEffect(() => {
    if (!highlightsLoaded) return;
    void saveTextHighlights(paperId, "translate", highlights);
  }, [highlights, highlightsLoaded, paperId]);

  // 划选监听
  useTextSelection(containersRef, (docKey, pending) => setSel({ ...pending, docKey }));

  // 内容渲染后重绘高亮
  useLayoutEffect(() => {
    for (const [el, docKey] of containersRef.current) {
      applyMarks(el, highlights.filter((h) => h.docKey === docKey));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, enMd, chunks, references, highlights]);

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

  async function handleTranslate() {
    if (!enMd || translating) return;
    setTranslating(true);
    setError(null);
    try {
      // 只翻译正文，参考文献不进 LLM（省 token）
      const parts = chunkMarkdown(body);
      const zh: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        zh.push(await translateChunk(parts[i]));
        setProgress({ done: i + 1, total: parts.length });
      }
      const result: TranslationChunk[] = parts.map((en, i) => ({ en, zh: zh[i] }));
      await saveTranslation(paperId, result);
      setChunks(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setTranslating(false);
      setProgress(null);
    }
  }

  // 当前模式对应的文档（纯英/纯中）；对照模式在渲染分支单独逐段渲染。
  // 纯中：正文译文 + 末尾附英文原版参考文献。
  function docFor(): string | null {
    if (mode === "en") return enMd;
    if (!chunks) return null;
    const zh = buildZhDoc(chunks);
    return mode === "zh" ? (references ? `${zh}\n\n${references}` : zh) : null;
  }

  const doc = docFor();
  const needsTranslate = mode !== "en" && !chunks;
  // 对照模式：按翻译块逐块对齐（块内错位不传播到后续块；未对齐内容完整展示）
  const bi = mode === "bi" && chunks ? pairChunks(chunks) : null;

  // 内容渲染后扫描 DOM 标题构建目录（对照模式跳过 .trans-zh 中文段，避免重复条目）
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const entries = extractHeadingEntries(scroller, ".trans-zh");
    flatEntriesRef.current = entries;
    const tree = buildHeadingTree(entries);
    setToc(tree);
    // 默认展开所有有子节点的条目
    const withItems = new Set<TocEntry>();
    const walk = (nodes: TocEntry[]) => {
      for (const n of nodes) {
        if (n.items.length) withItems.add(n);
        walk(n.items);
      }
    };
    walk(tree);
    setExpanded(withItems);
    setActiveEntry(null);
    updateActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, enMd, chunks, references]);

  /** 计算当前章节：视口顶部向下 16px 以内、最后一个标题 */
  function updateActive() {
    const scroller = scrollRef.current;
    const entries = flatEntriesRef.current;
    if (!scroller || entries.length === 0) {
      setActiveEntry(null);
      return;
    }
    const threshold = scroller.getBoundingClientRect().top + 16;
    let active: TocEntry | null = null;
    for (const e of entries) {
      if (e.el.getBoundingClientRect().top <= threshold) active = e;
      else break;
    }
    setActiveEntry(active);
  }

  function handleScroll() {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateActive();
    });
  }

  /** 点击目录跳转：平滑滚动 + 高亮闪烁（直接操作 DOM，避免重渲） */
  function jumpToHeading(entry: TocEntry) {
    entry.el.scrollIntoView({ block: "start", behavior: "smooth" });
    const el = entry.el;
    el.classList.remove("zp-heading-flash");
    void el.offsetWidth; // 强制重排以重启动画
    el.classList.add("zp-heading-flash");
    window.setTimeout(() => el.classList.remove("zp-heading-flash"), 1300);
    setActiveEntry(entry);
  }

  function toggleExpand(entry: TocEntry) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });
  }

  function renderToc(nodes: TocEntry[], depth: number) {
    return nodes.map((node, i) => (
      <div key={i}>
        <button
          className={`group flex w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left text-[13px] hover:bg-accent ${
            activeEntry === node ? "bg-accent" : ""
          }`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => jumpToHeading(node)}
          title={node.text}
        >
          {node.items.length > 0 ? (
            expanded.has(node) ? (
              <ChevronDown
                className="h-3 w-3 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node);
                }}
              />
            ) : (
              <ChevronRight
                className="h-3 w-3 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node);
                }}
              />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.text}</span>
        </button>
        {node.items.length > 0 && expanded.has(node) && (
          <div>{renderToc(node.items, depth + 1)}</div>
        )}
      </div>
    ));
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

  const sortedHighlights = [...highlights].sort(
    (a, b) => b.created_at - a.created_at,
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={showToc ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setShowToc((v) => !v)}
          title="目录"
        >
          <ListTree className="h-3.5 w-3.5" />
          <span className="ml-1 hidden sm:inline">目录</span>
        </Button>
        <div className="inline-flex rounded-lg bg-muted p-[3px]">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={`pressable rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                mode === m.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Button
          onClick={() => void handleTranslate()}
          disabled={translating || !enMd}
          size="sm"
        >
          {translating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : chunks ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <Languages className="mr-2 h-4 w-4" />
          )}
          {translating ? "翻译中…" : chunks ? "重新翻译" : "翻译论文"}
        </Button>
        {enMd && (
          <Button
            variant={showList ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setShowList((v) => !v)}
            title="译文标注列表"
          >
            <List className="h-3.5 w-3.5" />
            <span className="ml-1">
              注释{highlights.length ? ` ${highlights.length}` : ""}
            </span>
          </Button>
        )}
        {progress && (
          <span className="text-xs text-muted-foreground">
            第 {progress.done}/{progress.total} 段
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

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {loadingEn ? (
          <div className="flex flex-col gap-3 pt-4">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : bi ? (
          <div className="flex flex-col gap-4">
            {(bi.restEn.length > 0 || bi.restZh.length > 0) && (
              <p className="text-xs text-muted-foreground">
                英文 {bi.enCount} 段 / 中文 {bi.zhCount} 段，已配对 {bi.pairs.length} 段
                {bi.restEn.length > 0 &&
                  `；英文未对齐 ${bi.restEn.length} 段（无中文译文）`}
                {bi.restZh.length > 0 &&
                  `；中文未对齐 ${bi.restZh.length} 段（多余译文）`}
              </p>
            )}
            {bi.pairs.map((p, i) => {
              // 中文段去掉单独成行的图片与整块公式（避免与英文段重复），保留行内公式
              const zh = stripStandaloneImagesAndMath(p.zh).trim();
              return (
                <div
                  key={i}
                  className="flex flex-col gap-1.5"
                  ref={(el) => registerContainer(el, `trans:bi:${i}`)}
                >
                  <MarkdownView markdown={p.en} />
                  {zh && <MarkdownView markdown={zh} className="trans-zh" />}
                </div>
              );
            })}
            {/* 未配对英文段：缺中文译文，加徽标提示，内容不丢失 */}
            {bi.restEn.map((en, i) => (
              <div
                key={`un-${i}`}
                className="flex flex-col gap-1.5"
                ref={(el) => registerContainer(el, `trans:bi:rest:${i}`)}
              >
                <span className="inline-block w-fit rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  无中文译文
                </span>
                <MarkdownView markdown={en} />
              </div>
            ))}
            {/* 未配对中文段：多余译文，同样完整展示，不再静默丢弃 */}
            {bi.restZh.map((zh, i) => {
              const stripped = stripStandaloneImagesAndMath(zh).trim();
              return stripped ? (
                <div
                  key={`zun-${i}`}
                  className="flex flex-col gap-1.5"
                  ref={(el) => registerContainer(el, `trans:bi:zrest:${i}`)}
                >
                  <span className="inline-block w-fit rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    多余译文
                  </span>
                  <MarkdownView markdown={stripped} className="trans-zh" />
                </div>
              ) : null;
            })}
            {/* 末尾附英文原版参考文献（不翻译） */}
            {references && (
              <div
                className="border-t pt-3"
                ref={(el) => registerContainer(el, "trans:bi:refs")}
              >
                <MarkdownView markdown={references} />
              </div>
            )}
          </div>
        ) : needsTranslate ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
            <FileText className="h-10 w-10" />
            <p className="text-sm">还没有翻译，点击「翻译论文」自动生成中文译文</p>
          </div>
        ) : doc ? (
          <div ref={(el) => registerContainer(el, `trans:${mode}`)}>
            <MarkdownView markdown={doc} />
          </div>
        ) : null}
      </div>

      {/* 目录侧栏（MacDown 风格：按 h1–h6 层级嵌套） */}
      {showToc && (
        <div className="absolute inset-y-0 left-0 z-20 flex w-60 flex-col border-r bg-background/95 backdrop-blur">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-semibold">目录</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowToc(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {toc.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">
                该文档没有标题层级。
              </p>
            ) : (
              renderToc(toc, 0)
            )}
          </div>
        </div>
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
