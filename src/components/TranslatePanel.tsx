import { useEffect, useMemo, useState } from "react";
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
import { FileText, Languages, Loader2, RefreshCw } from "lucide-react";

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
 */
export function TranslatePanel({ paperId }: Props) {
  const [mode, setMode] = useState<Mode>("en");
  const [enMd, setEnMd] = useState<string | null>(null);
  const [chunks, setChunks] = useState<TranslationChunk[] | null>(null);
  const [loadingEn, setLoadingEn] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
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
    </div>
  );
}
