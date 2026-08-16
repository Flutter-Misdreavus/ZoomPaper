/**
 * 文件夹色板：10 色，参照 macOS 标签色。
 * 每色提供主色（圆点 / 图标着色）与明暗两套柔和底色（拖拽高亮、选中态）。
 */

export interface FolderColor {
  key: string;
  label: string;
  /** 主色（色点 / 图标着色） */
  swatch: string;
  /** 浅色背景上的柔和底色 */
  softLight: string;
  /** 深色背景上的柔和底色 */
  softDark: string;
}

export const FOLDER_COLORS: FolderColor[] = [
  { key: "red",    label: "红", swatch: "#e5484d", softLight: "rgba(229,72,77,0.12)",  softDark: "rgba(229,72,77,0.24)" },
  { key: "orange", label: "橙", swatch: "#f76b15", softLight: "rgba(247,107,21,0.12)", softDark: "rgba(247,107,21,0.24)" },
  { key: "yellow", label: "黄", swatch: "#f5a524", softLight: "rgba(245,165,36,0.14)", softDark: "rgba(245,165,36,0.24)" },
  { key: "green",  label: "绿", swatch: "#30a46c", softLight: "rgba(48,164,108,0.12)", softDark: "rgba(48,164,108,0.24)" },
  { key: "teal",   label: "青", swatch: "#12a594", softLight: "rgba(18,165,148,0.12)", softDark: "rgba(18,165,148,0.24)" },
  { key: "blue",   label: "蓝", swatch: "#3e8ef7", softLight: "rgba(62,142,247,0.12)", softDark: "rgba(62,142,247,0.24)" },
  { key: "purple", label: "紫", swatch: "#8e4ec6", softLight: "rgba(142,78,198,0.12)", softDark: "rgba(142,78,198,0.24)" },
  { key: "pink",   label: "粉", swatch: "#d6409f", softLight: "rgba(214,64,159,0.12)", softDark: "rgba(214,64,159,0.24)" },
  { key: "brown",  label: "棕", swatch: "#ad7f58", softLight: "rgba(173,127,88,0.14)", softDark: "rgba(173,127,88,0.26)" },
  { key: "gray",   label: "灰", swatch: "#8d8d8d", softLight: "rgba(141,141,141,0.14)", softDark: "rgba(141,141,141,0.26)" },
];

export function folderColor(key: string): FolderColor {
  return FOLDER_COLORS.find((c) => c.key === key) ?? FOLDER_COLORS[FOLDER_COLORS.length - 1];
}
