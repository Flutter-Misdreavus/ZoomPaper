/**
 * HTML 文本划选高亮的定位与重绘工具（博客 / 译文视图复用）。
 *
 * PDF 有归一化矩形可复算，HTML 没有——这里用「文档内字符偏移」锚定：
 * - 划选时 [`computeOffsets`] 把 selection 边界映射为容器文本节点的累计字符偏移；
 * - 渲染后 [`applyMarks`] 遍历文本节点，把 [start, end) 区间包成 `<mark>` 高亮 span；
 * - 内容重新生成/重翻后偏移可能失配：先按偏移校验切片文本与快照一致，
 *   失配回退「空白折叠归一化后的首次文本匹配」，仍找不到则跳过（仅保留在列表）。
 *
 * 跨元素边界的选区（如标题+段落）：按覆盖的文本节点逐段包裹，同一高亮 id 对应多个 span。
 * KaTeX 公式/代码块内的文本节点同样纳入遍历，因此选中公式文字也可标记。
 */

export interface TextHighlight {
  id: string;
  /** 渲染容器标识（如 `blog:body`、`blog:analysis:insight`、`trans:bi:5`） */
  docKey: string;
  /** 人类可读来源（如「博客·洞见」「译文·第 5 段」），供 AI 工具与引用区展示 */
  label: string;
  /** 容器文本节点累计字符偏移（含 KaTeX/代码文本节点） */
  start: number;
  end: number;
  /** 选中文本快照（偏移校验与回退匹配用） */
  text: string;
  /** CSS 颜色 */
  color: string;
  note: { text: string; updated_at: number } | null;
  created_at: number;
}

/** 空白折叠归一化（回退匹配与偏移校验用）：\s+ → 单个空格，去首尾空白。 */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface TextNodeEntry {
  node: Text;
  /** 该节点在容器文本中的起始偏移 */
  start: number;
  /** 该节点文本长度（char 数） */
  len: number;
}

/** 收集容器下全部文本节点（文档序）及累计偏移。 */
function collectTextNodes(container: HTMLElement): TextNodeEntry[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const entries: TextNodeEntry[] = [];
  let offset = 0;
  while (true) {
    const node = walker.nextNode() as Text | null;
    if (!node) break;
    // 跳过脚本/样式等无意义文本（react-markdown 不会产出，防御）
    if (!node.nodeValue || node.nodeValue.length === 0) continue;
    entries.push({ node, start: offset, len: node.nodeValue.length });
    offset += node.nodeValue.length;
  }
  return entries;
}

/** 容器内第 charOffset 个字符对应的 (节点, 节点内偏移)；越界返回末尾节点。 */
function locate(
  entries: TextNodeEntry[],
  charOffset: number,
): { entry: TextNodeEntry; within: number } | null {
  if (entries.length === 0) return null;
  // 选择结束边界常见「等于总长」的情况 → 落在最后节点末尾
  for (const entry of entries) {
    if (charOffset < entry.start + entry.len) {
      return { entry, within: charOffset - entry.start };
    }
  }
  const last = entries[entries.length - 1];
  return { entry: last, within: last.len };
}

export interface OffsetsResult {
  /** 归一化后的选区文本（跨块时用容器文本子串） */
  text: string;
  start: number;
  end: number;
}

/**
 * 把 selection range 映射为容器内的字符偏移。
 * 返回空字符串表示选区为空或无法定位（range 在容器之外等）。
 */
export function computeOffsets(container: HTMLElement, range: Range): OffsetsResult | null {
  const entries = collectTextNodes(container);
  if (entries.length === 0) return null;
  const totalLen = entries[entries.length - 1].start + entries[entries.length - 1].len;

  // range 起点可能在容器外的文本节点（例如跨容器选区）→ 夹紧到容器范围
  const start = Math.max(0, Math.min(totalLen, mapBoundary(entries, range.startContainer, range.startOffset)));
  const end = Math.max(0, Math.min(totalLen, mapBoundary(entries, range.endContainer, range.endOffset)));
  if (end <= start) return null;

  const text = textSlice(entries, start, end).trim();
  if (!text) return null;
  return { text, start, end };
}

/** 把 (节点, 节点内偏移) 映射为容器字符偏移；节点不在容器内时按位置夹紧。 */
function mapBoundary(entries: TextNodeEntry[], container: Node, offset: number): number {
  // 边界节点通常是 Text；若是元素节点（如 range 定位在元素上），用其首个子文本
  const node: Node = container.nodeType === Node.TEXT_NODE ? container : firstTextDescendant(container as Element);
  const entry = entries.find((e) => e.node === node);
  if (entry) return Math.min(entry.len, Math.max(0, offset)) + entry.start;
  // 不在容器内（跨容器选区）：按节点顺序估算位置（就近夹紧）
  return approximateOffset(entries, node);
}

function firstTextDescendant(el: Element): Node {
  return el.firstChild ?? el;
}

/** 节点不在收集表内时：按其 DOM 顺序推断近似偏移（取前一个/后一个已知节点的边界）。 */
function approximateOffset(entries: TextNodeEntry[], node: Node): number {
  let before = 0;
  for (const e of entries) {
    const cmp = e.node.compareDocumentPosition(node);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) {
      break; // node 在当前节点之后 → 偏移应落在当前节点区间内
    }
    if (cmp & Node.DOCUMENT_POSITION_PRECEDING) {
      before = e.start + e.len;
    }
  }
  return before;
}

/** 取容器文本 [start, end) 子串。 */
export function textSlice(entries: TextNodeEntry[], start: number, end: number): string {
  let out = "";
  for (const e of entries) {
    if (e.start >= end) break;
    const from = Math.max(start, e.start);
    const to = Math.min(end, e.start + e.len);
    if (to > from) {
      out += e.node.nodeValue!.slice(from - e.start, to - e.start);
    }
  }
  return out;
}

/**
 * 在容器内把高亮渲染为 `<mark>` 包裹（幂等：先解包旧标记再按当前列表重包）。
 * 偏移有效（切片文本与快照归一化一致）时按偏移包裹；否则回退首次文本匹配；
 * 找不到则跳过。仅对目标文本节点做 split + wrap，不影响其他 DOM。
 * 重叠高亮：后包者可能因嵌套 partial 选区失败（try/catch 跳过，不崩溃）。
 */
export function applyMarks(container: HTMLElement, highlights: TextHighlight[]): void {
  // 解包旧标记（内容原样保留）
  container.querySelectorAll("mark.zp-text-highlight").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  if (highlights.length === 0) return;

  const entries = collectTextNodes(container);
  if (entries.length === 0) return;

  for (const hl of highlights) {
    wrapRange(entries, hl);
  }
}

function wrapRange(
  entries: TextNodeEntry[],
  hl: TextHighlight,
): void {
  // 1) 按偏移定位并校验切片
  let start = hl.start;
  let end = hl.end;
  const slice = textSlice(entries, start, end);
  const snapshot = normalizeText(hl.text);
  if (!slice || normalizeText(slice) !== snapshot) {
    // 2) 回退：归一化后首次匹配
    const found = findNormalized(entries, snapshot);
    if (!found) return;
    start = found.start;
    end = found.end;
  }
  if (end <= start) return;

  // 逐节点切分包裹（跨元素边界拆成多个 mark span，同一 id）
  let cursor = start;
  const positions = locate(entries, start);
  const positionsEnd = locate(entries, end);
  if (!positions || !positionsEnd) return;
  const startIdx = entries.indexOf(positions.entry);
  const endIdx = entries.indexOf(positionsEnd.entry);
  for (let i = startIdx; i <= endIdx; i++) {
    const e = entries[i];
    const segStart = Math.max(cursor, e.start);
    const segEnd = Math.min(end, e.start + e.len);
    if (segEnd <= segStart) continue;
    wrapSegment(e.node, segStart - e.start, segEnd - e.start, hl);
    cursor = segEnd;
  }
}

/** 对文本节点 [from, to) 段做 split + wrap（不动其余文本）。 */
function wrapSegment(node: Text, from: number, to: number, hl: TextHighlight): void {
  const parent = node.parentElement;
  if (!parent || to <= from) return;
  const mark = document.createElement("mark");
  mark.className = "zp-text-highlight";
  mark.dataset.hlId = hl.id;
  mark.style.background = hl.color;
  mark.style.borderRadius = "2px";
  mark.style.padding = "0 1px";
  mark.style.cursor = "pointer";
  mark.title = hl.note?.text ? `笔记：${hl.note.text}` : "点击查看/编辑笔记";

  // 文本节点的分割：range 定位最稳妥（不依赖 splitText 的引用失效问题）
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  range.surroundContents(mark);
}

/** 归一化文本的首次匹配：返回容器偏移区间；找不到返回 null。 */
function findNormalized(
  entries: TextNodeEntry[],
  target: string,
): { start: number; end: number } | null {
  if (!target) return null;
  const totalLen = entries[entries.length - 1].start + entries[entries.length - 1].len;
  // 朴素扫描：容器文本长度有限（博客/译文单视图），逐位置比较归一化子串成本可控
  const targetLen = target.length;
  for (let start = 0; start + targetLen <= totalLen; start++) {
    const slice = textSlice(entries, start, start + targetLen);
    if (normalizeText(slice) === target) {
      return { start, end: start + targetLen };
    }
  }
  return null;
}
