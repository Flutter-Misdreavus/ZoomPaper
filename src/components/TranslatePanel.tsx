import { useEffect, useState } from "react";
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
import { buildBiDoc, buildZhDoc, chunkMarkdown } from "@/lib/translate";
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
 * AI 翻译：把论文 paper.md 分块译成中文，本地缓存为 translation.json。
 * 三种模式是同一份 Markdown 的不同拼接：纯英 = 原文；纯中 = 中文块拼接；
 * 对照 = 英文块与中文块按序交错（分段交错）。
 */
export function TranslatePanel({ paperId }: Props) {
  const [mode, setMode] = useState<Mode>("en");
  const [enMd, setEnMd] = useState<string | null>(null);
  const [chunks, setChunks] = useState<TranslationChunk[] | null>(null);
  const [loadingEn, setLoadingEn] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const parts = chunkMarkdown(enMd);
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

  // 当前模式对应的文档；切到中文/对照但尚未翻译时返回 null
  function docFor(): string | null {
    if (mode === "en") return enMd;
    if (!chunks) return null;
    return mode === "zh" ? buildZhDoc(chunks) : buildBiDoc(chunks);
  }

  const doc = docFor();
  const needsTranslate = mode !== "en" && !chunks;

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
