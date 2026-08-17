import { useState } from "react";
import {
  BookOpenText,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  HelpCircle,
  Highlighter,
  Languages,
  Library,
  Link2,
  ListTree,
  Loader2,
  MousePointerClick,
  Search,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ToolStep } from "@/lib/api";

/** 实时轨迹条目：ToolStep + 运行态（生成中）与单工具耗时 */
export type LiveToolStep = ToolStep & {
  running?: boolean;
  elapsed_ms?: number;
};

/** 工具展示元信息：人类可读名称 + 分类图标（DSH GenericCallView 式） */
const TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  search_papers: { label: "检索论文库", icon: Search },
  read_section: { label: "精读章节", icon: BookOpenText },
  get_outline: { label: "查看章节目录", icon: ListTree },
  get_paper_meta: { label: "查看论文元数据", icon: FileText },
  list_papers: { label: "列出论文库", icon: Library },
  read_annotations: { label: "读取阅读标注", icon: Highlighter },
  read_translation: { label: "读取中文译文", icon: Languages },
  web_search: { label: "联网搜索", icon: Globe },
  web_fetch: { label: "抓取网页", icon: Link2 },
  read_selection: { label: "读取选中段落", icon: MousePointerClick },
  ask_user: { label: "向用户澄清", icon: HelpCircle },
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 从参数提炼一句话要点（卡片标题用；DSH rawInput 式） */
function salientArg(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  switch (name) {
    case "search_papers":
    case "web_search":
      return str(a.query);
    case "read_section":
      return str(a.topic);
    case "web_fetch":
      return str(a.url);
    case "read_translation":
      return str(a.keywords);
    case "read_selection":
      return a.index != null ? String(a.index) : "";
    case "ask_user":
      return str(a.question);
    default:
      return "";
  }
}

/** 卡片标题：如「精读章节：方法」 */
function toolTitle(name: string, args: unknown): string {
  const label = TOOL_META[name]?.label ?? name;
  const salient = salientArg(name, args);
  return salient ? `${label}：${salient}` : label;
}

/** 参数是否值得展示（有键的非空对象） */
function hasArgs(args: unknown): boolean {
  return (
    !!args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args as Record<string, unknown>).length > 0
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 单张工具卡片：标题行（图标 + 人类可读标题 + 状态 + 展开箭头）恒可见，详情可展开 */
function ToolCard({ step }: { step: LiveToolStep }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[step.name] ?? { label: step.name, icon: Wrench };
  const Icon = meta.icon;
  const title = toolTitle(step.name, step.args);
  return (
    <div className="overflow-hidden rounded-lg border bg-background/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        {step.running ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            执行中
          </span>
        ) : step.error ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-destructive">
            <XCircle className="h-3 w-3" />
            失败
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <CheckCircle2 className="h-3 w-3 text-green-600/80" />
            {step.elapsed_ms != null && step.elapsed_ms > 0 ? fmtMs(step.elapsed_ms) : "完成"}
          </span>
        )}
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="border-t px-2.5 py-2 text-xs">
          {hasArgs(step.args) && (
            <>
              <div className="mb-0.5 text-[10px] text-muted-foreground/70">参数</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {JSON.stringify(step.args, null, 2)}
              </pre>
            </>
          )}
          {step.summary && (
            <div className="mt-1 break-words text-muted-foreground">
              <span className="text-muted-foreground/70">结果：</span>
              {step.summary}
              {step.elapsed_ms != null && step.elapsed_ms > 0 && !step.error && (
                <span className="ml-1 text-muted-foreground/70">（{fmtMs(step.elapsed_ms)}）</span>
              )}
            </div>
          )}
          {step.error && (
            <div className="mt-1 break-words text-destructive">
              <span className="text-destructive/70">错误：</span>
              {step.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 「工作」区：工具调用列表，**默认收纳**为胶囊；展开后为结构化工具卡片
 * （标题 + 分类图标 + 状态 + 可展开详情），形式参考 DSH 的工具卡展示。
 */
export function ToolTrace({ trace }: { trace?: LiveToolStep[] | null }) {
  const [open, setOpen] = useState(false);
  if (!trace || trace.length === 0) return null;
  const errors = trace.filter((t) => t.error).length;
  const running = trace.some((t) => t.running);

  return (
    <div className="flex w-full flex-col items-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pressable inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Wrench className="h-3 w-3" />
        工具调用（{trace.length}）
        {running && <span className="text-primary">· 执行中</span>}
        {errors > 0 && <span className="text-destructive">· {errors} 个失败</span>}
      </button>
      {open && (
        <div className="mt-1.5 flex w-full flex-col gap-1.5">
          {trace.map((step, i) =>
            step.name === "quick_fallback" ? (
              // 回退提示：非工具调用，渲染为中性信息行
              <div
                key={i}
                className="rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground"
              >
                {step.summary}
              </div>
            ) : (
              <ToolCard key={i} step={step} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
