import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/MarkdownView";
import {
  getPaperMd,
  getTranslation,
  saveTranslation,
  translateChunk,
  type TranslationChunk,
} from "@/lib/api";
import {
  buildZhDoc,
  chunkMarkdown,
  pairBlocks,
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
  ListTree,
  Loader2,
  RefreshCw,
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
}

/**
 * AI 翻译：把论文 paper.md 正文分块译成中文（参考文献不翻译、不进 LLM 省 token），
 * 本地缓存为 translation.json（带版本号）。纯英 = 完整原文；纯中 = 正文译文 + 末尾英文原版
 * 参考文献；对照 = 正文按段落逐段配对（英文段黑色 + 中文段浅蓝色）+ 末尾英文原版参考文献。
 *
 * 目录：扫描渲染后 DOM 的 h1–h6 构建 MacDown 风格大纲（对照模式跳过 .trans-zh 中文段标题，
 * 避免重复条目），点击平滑滚动 + 高亮闪烁，滚动时当前章节跟随高亮。
 */
export function TranslatePanel({ paperId }: Props) {
  const [mode, setMode] = useState<Mode>("en");
  const [enMd, setEnMd] = useState<string | null>(null);
  const [chunks, setChunks] = useState<TranslationChunk[] | null>(null);
  const [loadingEn, setLoadingEn] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  // 对照模式：正文（不含参考文献）与中文全文各自按段切分后配对
  const bi =
    mode === "bi" && chunks && body
      ? pairBlocks(body, buildZhDoc(chunks))
      : null;

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
            {bi.enCount !== bi.zhCount && (
              <p className="text-xs text-muted-foreground">
                英文 {bi.enCount} 段 / 中文 {bi.zhCount} 段，已按序配对前 {bi.pairs.length}
                段，其余未对齐。
              </p>
            )}
            {bi.pairs.map((p, i) => {
              // 中文段去掉单独成行的图片与整块公式（避免与英文段重复），保留行内公式
              const zh = stripStandaloneImagesAndMath(p.zh).trim();
              return (
                <div key={i} className="flex flex-col gap-1.5">
                  <MarkdownView markdown={p.en} />
                  {zh && <MarkdownView markdown={zh} className="trans-zh" />}
                </div>
              );
            })}
            {bi.restEn.map((en, i) => (
              <MarkdownView key={`un-${i}`} markdown={en} />
            ))}
            {/* 末尾附英文原版参考文献（不翻译） */}
            {references && (
              <div className="border-t pt-3">
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
          <MarkdownView markdown={doc} />
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
    </div>
  );
}
