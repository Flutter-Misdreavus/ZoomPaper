// 全局配色方案：预设清单、localStorage 持久化与 <html data-scheme> 应用
// 配色变量块在 styles.css；默认 green 保留上游现有配色。

export type ThemeScheme = "mono" | "red" | "green" | "blue" | "purple" | "yellow" | "dark" | "custom";

export interface ThemePreset {
  key: Exclude<ThemeScheme, "custom">;
  label: string;
  /** 设置页色板圆点颜色 */
  swatch: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { key: "mono", label: "黑白", swatch: "#171717" },
  { key: "red", label: "红", swatch: "#c62828" },
  { key: "green", label: "绿", swatch: "#27665b" },
  { key: "blue", label: "蓝", swatch: "#2563eb" },
  { key: "purple", label: "紫", swatch: "#6d28d9" },
  { key: "yellow", label: "黄", swatch: "#eab308" },
  { key: "dark", label: "深色", swatch: "#262626" },
];

export const DEFAULT_SCHEME: ThemeScheme = "green";
export const DEFAULT_CUSTOM_COLOR = "#27665b";

export interface ThemeState {
  scheme: ThemeScheme;
  /** scheme 为 custom 时生效的主色 */
  customColor: string;
}

export const THEME_KEY = "zoompaper.theme";
export const THEME_CHANGED_EVENT = "zoompaper:theme-changed";

const SCHEMES: ThemeScheme[] = ["mono", "red", "green", "blue", "purple", "yellow", "dark", "custom"];

function isScheme(v: unknown): v is ThemeScheme {
  return typeof v === "string" && (SCHEMES as string[]).includes(v);
}

function validColor(value: unknown): value is string { return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value); }

export function getTheme(): ThemeState {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw) {
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw) as { scheme?: unknown; customColor?: unknown };
        return {
          scheme: isScheme(parsed.scheme) ? parsed.scheme : DEFAULT_SCHEME,
          customColor: validColor(parsed.customColor) ? parsed.customColor : DEFAULT_CUSTOM_COLOR,
        };
      }
      // 兼容裸字符串写法（如 "green"）
      if (isScheme(raw)) return { scheme: raw, customColor: DEFAULT_CUSTOM_COLOR };
    }
  } catch {
    // 数据损坏或 localStorage 不可用时回退默认
  }
  return { scheme: DEFAULT_SCHEME, customColor: DEFAULT_CUSTOM_COLOR };
}

/** 相对亮度（WCAG，0–1），用于给自定义主色挑选可读的按钮文字色 */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = Number.parseInt(m[1], 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** 把方案写到 <html data-scheme>；custom 时内联 --primary/--primary-foreground（内联优先级高于 CSS 块） */
export function applyTheme(state: ThemeState): void {
  const root = document.documentElement;
  root.dataset.scheme = state.scheme;
  root.classList.toggle("dark", state.scheme === "dark");
  if (state.scheme === "custom") {
    root.style.setProperty("--primary", state.customColor);
    root.style.setProperty(
      "--primary-foreground",
      luminance(state.customColor) > 0.4 ? "#1a1a1a" : "#ffffff",
    );
  } else {
    root.style.removeProperty("--primary");
    root.style.removeProperty("--primary-foreground");
  }
}

export function setTheme(scheme: ThemeScheme, customColor?: string): ThemeState {
  const next: ThemeState = {
    scheme,
    customColor: validColor(customColor) ? customColor : getTheme().customColor,
  };
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(next));
  } catch {
    // 忽略持久化失败
  }
  applyTheme(next);
  applyCustomTheme(getCustomTheme(), scheme);
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
  return next;
}

// JSON 高级主题

export interface CustomTheme {
  name: string;
  vars: Record<string, string>;
  /** 仅 scheme === "dark" 时应用的覆盖段 */
  dark?: Record<string, string> | null;
}

const CUSTOM_THEME_KEY = "zoompaper.customTheme";
/** 已由 JSON 主题内联注入的变量名，供下次清除 */
let injectedVars: string[] = [];

function isValidVarKey(key: string): boolean {
  return /^[a-z0-9-]+$/.test(key);
}

function isValidVarValue(value: string): boolean {
  // 拒绝可能逃逸 style 上下文的字符
  return !/[{};]/.test(value);
}

/** 把 JSON 主题以内联 style 注入 <html>（内联优先级高于方案块，天然覆盖预设） */
export function applyCustomTheme(theme: CustomTheme | null, scheme: ThemeScheme): void {
  const root = document.documentElement;
  for (const key of injectedVars) root.style.removeProperty(`--${key}`);
  injectedVars = [];
  if (!theme) return;
  const sections = [theme.vars, scheme === "dark" ? (theme.dark ?? {}) : {}];
  for (const section of sections) {
    for (const [key, value] of Object.entries(section ?? {})) {
      if (!isValidVarKey(key) || typeof value !== "string" || !isValidVarValue(value)) continue;
      root.style.setProperty(`--${key}`, value);
      injectedVars.push(key);
    }
  }
}

export function getCustomTheme(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CustomTheme;
      if (parsed && typeof parsed.name === "string" && parsed.vars && typeof parsed.vars === "object") {
        return parsed;
      }
    }
  } catch {
    // 数据损坏时视为无高级主题
  }
  return null;
}

/** 选中/清除 JSON 高级主题；全量缓存到 localStorage 供 index.html 启动脚本无闪烁注入 */
export function setCustomTheme(theme: CustomTheme | null): void {
  try {
    if (theme) localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
    else localStorage.removeItem(CUSTOM_THEME_KEY);
  } catch {
    // 忽略持久化失败
  }
  applyCustomTheme(theme, getTheme().scheme);
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
}
