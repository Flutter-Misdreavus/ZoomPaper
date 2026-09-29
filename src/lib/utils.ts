import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { ParseProgress } from "@/lib/api"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 复制兜底：navigator.clipboard 不可用时走 execCommand */
export async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 走兜底 */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** unix 秒 → 「M月D日 HH:mm」本地时间 */
export function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 秒 → 紧凑时长：「45 秒」「12 分钟」「1 小时 5 分钟」 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

/** 将学术站点元数据里的少量 HTML 转为适合桌面列表显示的纯文本。 */
export function displayPaperTitle(title: string): string {
  const superscript: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  };
  return title
    .replace(/<sup>(.*?)<\/sup>/gi, (_, value: string) =>
      [...value].map((char) => superscript[char] ?? char).join(""),
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
/** 解析进度 → 进度条百分比（0~100）。running 阶段按页数换算到 15~85 区间。 */
export function parseProgressPercent(p: ParseProgress): number {
  switch (p.stage) {
    case "uploading":
      return 5;
    case "pending":
      return 10;
    case "converting":
      return 15;
    case "running": {
      const { extracted_pages: done, total_pages: total } = p;
      if (done != null && total != null && total > 0) {
        return 15 + Math.min(1, done / total) * 70;
      }
      return 15;
    }
    case "downloading":
      return 90;
    case "indexing":
      return 95;
    case "translating_metadata":
      return 98;
    default:
      return 0;
  }
}
