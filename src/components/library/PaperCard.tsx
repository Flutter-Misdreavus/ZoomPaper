/**
 * 论文卡片（PaperCard）：状态驱动极简卡片。
 * 结构：复选框 + 状态圆点 + 标题(2行截断) + 作者(1行) + 解析 pill + 星标 + 更多。
 * 交互：单击主体无操作（不进入选择）；复选框为选择唯一入口（toggle）；
 * 双击主体打开；星标独立响应不触发选择；拖拽未选中卡片时自动并入选择。
 */
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useMemo } from "react";
import { Check, MoreHorizontal, Star } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { folderColor } from "@/lib/folderColors";
import { PAPER_DRAG_MIME } from "@/lib/folders";
import type { Folder, Paper, ReadingStatus } from "@/lib/api";
import { PaperMenuItems, type PaperMenuActions } from "./paperMenu";
import { RenameInput } from "./RenameInput";

/** 解析状态 pill：已解析深色填充，其余弱化 */
const PARSE_STYLE: Record<string, { label: string; className: string }> = {
  ready: { label: "已解析", className: "bg-zp-primary text-white" },
  parsing: { label: "解析中…", className: "bg-zp-surface-hover text-zp-tertiary" },
  unparsed: { label: "未解析", className: "bg-zp-surface-hover text-zp-tertiary" },
  failed: { label: "解析失败", className: "bg-red-500/10 text-red-600" },
};

/** 阅读状态圆点：未读=实心黑 / 在读=实心灰 / 已读=浅灰描边 */
const STATUS_DOT: Record<ReadingStatus, string> = {
  unread: "bg-zp-primary",
  reading: "bg-zp-tertiary",
  read: "border border-zp-border",
};

function readingStatusOf(s: string): ReadingStatus {
  return s === "unread" || s === "reading" || s === "read" ? s : "unread";
}

export interface PaperCardProps {
  paper: Paper;
  /** 全部文件夹（用于解析归属色点与名称） */
  folders: Folder[];
  selected: boolean;
  selectedIds: ReadonlySet<string>;
  /** 选择模式：任意卡片被选中时，所有复选框常驻可见 */
  selectionMode: boolean;
  isRenaming: boolean;
  parsing: boolean;
  /** 当前处于某文件夹视图时的 folderId；null = 全部/未分类视图 */
  currentFolderId: string | null;
  onToggle: (paperId: string) => void;
  onOpen: (paperId: string) => void;
  onStartRename: (paper: Paper) => void;
  onCommitRename: (paper: Paper, title: string) => void;
  onCancelRename: () => void;
  /** 打开归属面板；未选中该论文时以它为目标 */
  onPickFolder: (paper: Paper) => void;
  onSetStatus: (paper: Paper, status: ReadingStatus) => void;
  /** 加入阅读计划（当前进行中的指派论文计划；无则自动新建） */
  onAddToPlan: (paper: Paper) => void;
  onToggleStar: (paper: Paper) => void;
  /** 点击文件夹 pill 跳转到对应文件夹视图 */
  onJumpToFolder: (folderId: string) => void;
  onParse: (paperId: string) => void;
  onDelete: (paper: Paper) => void;
  onRemoveFromCurrentFolder: (paper: Paper) => void;
}

export function PaperCard(props: PaperCardProps) {
  const {
    paper,
    folders,
    selected,
    selectedIds,
    selectionMode,
    isRenaming,
    parsing,
    currentFolderId,
    onToggle,
    onOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onPickFolder,
    onSetStatus,
    onAddToPlan,
    onToggleStar,
    onJumpToFolder,
    onParse,
    onDelete,
    onRemoveFromCurrentFolder,
  } = props;

  const st = PARSE_STYLE[paper.parse_status] ?? PARSE_STYLE.unparsed;
  const status = readingStatusOf(paper.reading_status);
  const reduceMotion = useReducedMotion();
  // 归属文件夹（多归属；按 id 解析，脏数据过滤）
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const paperFolders = paper.folder_ids
    .map((id) => folderById.get(id))
    .filter((f): f is Folder => Boolean(f));

  const menuActions: PaperMenuActions = {
    onOpen: () => onOpen(paper.id),
    onRename: () => onStartRename(paper),
    onPickFolder: () => onPickFolder(paper),
    onRemoveFromCurrentFolder: currentFolderId
      ? () => onRemoveFromCurrentFolder(paper)
      : undefined,
    onSetStatus: (s) => onSetStatus(paper, s),
    onAddToPlan: () => onAddToPlan(paper),
    currentStatus: status,
    onDelete: () => onDelete(paper),
  };

  function handleDragStart(e: React.DragEvent) {
    const ids = selected ? [...selectedIds] : [paper.id];
    if (!selected) onToggle(paper.id);
    e.dataTransfer.setData(PAPER_DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger
        render={
          <motion.div
            initial={{ opacity: 0, ...(reduceMotion ? {} : { transform: "translateY(8px)" }) }}
            animate={{ opacity: 1, ...(reduceMotion ? {} : { transform: "translateY(0)" }) }}
            transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
          >
            <div
              draggable
              onDragStart={handleDragStart}
              tabIndex={0}
              role="button"
              aria-label={paper.title}
              // 单击主体无操作：选择只通过复选框进入，打开只通过双击 / Enter
              onDoubleClick={() => onOpen(paper.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(paper.id);
                }
              }}
              className={cn(
                "group relative flex cursor-default flex-col gap-1 rounded-[10px] border bg-white p-4 outline-none transition-all select-none",
                "dark:bg-zp-surface",
                selected
                  ? "border-zp-primary shadow-[0_0_0_1px] shadow-zp-primary"
                  : "border-zp-border hover:border-[#d4d4d4] hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              {/* header：复选框 + 状态圆点 + 标题 + 星标/更多 */}
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={selected ? "取消选择" : "选择"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(paper.id);
                  }}
                  className={cn(
                    "mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-all",
                    selected
                      ? "border-zp-primary bg-zp-primary text-white opacity-100"
                      : "border-zp-border bg-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 dark:bg-zp-surface",
                    selectionMode && "opacity-100"
                  )}
                >
                  {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                </button>

                <span
                  className={cn("mt-[7px] h-2 w-2 shrink-0 rounded-full", STATUS_DOT[status])}
                  title={{ unread: "未读", reading: "在读", read: "已读" }[status]}
                />

                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <RenameInput
                      initialValue={paper.title}
                      width={Math.min(400, Math.max(180, paper.title.length * 14))}
                      onCommit={(v) => onCommitRename(paper, v)}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <h3 className="line-clamp-2 text-[15px] leading-[1.4] font-medium text-zp-primary">
                      {paper.title}
                    </h3>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-0.5">
                  {/* 星标：独立响应，不触发选择 */}
                  <button
                    type="button"
                    title={paper.starred ? "取消星标" : "添加星标"}
                    aria-label={paper.starred ? "取消星标" : "添加星标"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleStar(paper);
                    }}
                    className={cn(
                      "pressable flex h-5 w-5 items-center justify-center transition-opacity",
                      paper.starred
                        ? "text-zp-primary opacity-100"
                        : "text-zp-quaternary opacity-0 group-hover:opacity-100 hover:text-zp-primary focus-visible:opacity-100"
                    )}
                  >
                    <Star
                      className={cn("h-[18px] w-[18px]", paper.starred && "fill-current")}
                      strokeWidth={1.8}
                    />
                  </button>

                  {/* ⋯ 更多菜单（与右键菜单同构） */}
                  <MenuPrimitive.Root>
                    <MenuPrimitive.Trigger
                      render={
                        <button
                          type="button"
                          title="更多操作"
                          aria-label="更多操作"
                          className="pressable flex h-7 w-7 items-center justify-center rounded-full text-zp-quaternary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zp-surface-hover hover:text-zp-primary focus-visible:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      }
                    />
                    <MenuPrimitive.Portal>
                      <MenuPrimitive.Positioner
                        align="end"
                        alignOffset={0}
                        sideOffset={4}
                        className="isolate z-50"
                      >
                        <MenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                          <PaperMenuItems Item={MenuPrimitive.Item} actions={menuActions} />
                        </MenuPrimitive.Popup>
                      </MenuPrimitive.Positioner>
                    </MenuPrimitive.Portal>
                  </MenuPrimitive.Root>
                </div>
              </div>

              {/* 作者：单行截断 */}
              {paper.authors && (
                <p className="truncate pl-[42px] text-[13px] leading-[1.5] text-zp-tertiary">
                  {paper.authors}
                </p>
              )}

              {/* footer：解析状态 pill + 归属文件夹 pill（最多 3 个，点击跳转） */}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[42px]">
                <span
                  className={cn(
                    "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] leading-[1.3] font-medium",
                    st.className
                  )}
                >
                  {st.label}
                </span>
                {paper.parse_status !== "ready" && (
                  <button
                    type="button"
                    disabled={parsing}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onParse(paper.id);
                    }}
                    className="text-[11px] text-zp-quaternary underline-offset-2 transition-colors hover:text-zp-primary hover:underline disabled:opacity-50"
                  >
                    {parsing
                      ? "解析中…"
                      : paper.parse_status === "failed"
                        ? "重新解析"
                        : "解析"}
                  </button>
                )}
                {paperFolders.slice(0, 3).map((f) => {
                  const c = folderColor(f.color);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      title={f.tags.length > 0 ? `${f.name} · ${f.tags.join(" / ")}` : f.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToFolder(f.id);
                      }}
                      className="pressable flex max-w-28 items-center gap-1 rounded-md bg-zp-surface-hover px-1.5 py-0.5 text-[11px] text-zp-quaternary transition-colors hover:text-zp-primary"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.swatch }}
                      />
                      <span className="truncate">{f.name}</span>
                    </button>
                  );
                })}
                {paperFolders.length > 3 && (
                  <span className="text-[11px] text-zp-quaternary">
                    +{paperFolders.length - 3}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        }
      />
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner alignOffset={4} className="isolate z-50">
          <ContextMenuPrimitive.Popup className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <PaperMenuItems Item={ContextMenuPrimitive.Item} actions={menuActions} />
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
