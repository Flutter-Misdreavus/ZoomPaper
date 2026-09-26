import { useEffect, useMemo, useState } from "react";
import { Check, FileText } from "lucide-react";
import type { ReadingStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

function fallbackFavicon(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" ? `${url.origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

export function VenueBadge({ venue, sourceUrl, iconUrl, compact = false, status }: { venue: string | null; sourceUrl?: string | null; iconUrl?: string | null; compact?: boolean; status?: ReadingStatus }) {
  const candidates = useMemo(() => [...new Set([iconUrl, fallbackFavicon(sourceUrl ?? null)].filter((url): url is string => Boolean(url)))], [iconUrl, sourceUrl]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  useEffect(() => setCandidateIndex(0), [candidates.join("|")]);
  const src = candidates[candidateIndex] ?? null;
  let sourceHost: string | null = null;
  try { sourceHost = sourceUrl ? new URL(sourceUrl).hostname : null; } catch { /* fall through */ }
  return (
    <span title={venue || sourceHost || "未识别来源网站"} className={cn(compact ? "h-7 w-7" : "h-8 w-8", "relative flex shrink-0 items-center justify-center rounded-lg border bg-white dark:bg-zp-surface", status === "unread" ? "border-zp-tertiary" : "border-zp-border")}>
      {src ? <img src={src} alt="" className={cn(compact ? "h-4 w-4" : "h-[18px] w-[18px]", "object-contain")} onError={() => setCandidateIndex((index) => index + 1)} /> : <FileText className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4", "text-zp-quaternary")} />}
      <StatusMark status={status} />
    </span>
  );
}

function StatusMark({ status }: { status?: ReadingStatus }) {
  if (!status) return null;
  if (status === "read") {
    return <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white bg-zp-tertiary text-white dark:border-zp-surface"><Check className="h-2.5 w-2.5" strokeWidth={3} /></span>;
  }
  return <span className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white dark:border-zp-surface", status === "unread" ? "bg-zp-primary" : "bg-amber-500")} />;
}
