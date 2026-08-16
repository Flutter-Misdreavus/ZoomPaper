/**
 * Markdown 文档大纲（MacDown 风格）：
 * 从渲染后的 DOM 收集 h1–h6 标题并按层级构建树，供「目录」面板使用。
 */

/** 一个标题条目（el 为渲染后的 DOM 标题元素，用于滚动定位） */
export interface TocEntry {
  /** markdown 层级 1..6 */
  level: number;
  /** 标题文本（去首尾空白） */
  text: string;
  /** 对应渲染后的 DOM 标题元素 */
  el: HTMLElement;
  /** 子标题（层级更深且按顺序隶属于它） */
  items: TocEntry[];
}

/** 跳过选择器内的标题（如对照模式的中文段 `article.trans-zh`），避免重复条目 */
export function extractHeadingEntries(
  container: HTMLElement,
  skipSelector?: string,
): TocEntry[] {
  const entries: TocEntry[] = [];
  const heads = container.querySelectorAll("h1,h2,h3,h4,h5,h6");
  for (const el of heads) {
    if (skipSelector && el.closest(skipSelector)) continue;
    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    entries.push({
      level: Number(el.tagName.slice(1)),
      text,
      el: el as HTMLElement,
      items: [],
    });
  }
  return entries;
}

/**
 * MacDown 式层级嵌套：栈算法。
 * 新标题入栈前弹出所有 level ≥ 当前 level 的栈顶，从而正确嵌套并处理跳级
 * （H1→H3：H3 挂到 H1 下；H1→H2→H4：H4 挂到 H2 下；H3→H2：H2 重新挂到 H1 下）。
 */
export function buildHeadingTree(entries: TocEntry[]): TocEntry[] {
  const roots: TocEntry[] = [];
  const stack: TocEntry[] = [];
  for (const entry of entries) {
    while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(entry);
    } else {
      stack[stack.length - 1].items.push(entry);
    }
    stack.push(entry);
  }
  return roots;
}
