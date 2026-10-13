import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_COLOR,
  DEFAULT_SCHEME,
  applyTheme,
  applyCustomTheme, getCustomTheme, setCustomTheme,
  getTheme,
  setTheme,
} from "@/lib/theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-scheme");
  document.documentElement.style.removeProperty("--primary");
  document.documentElement.style.removeProperty("--primary-foreground");
});

describe("theme", () => {
  it("returns the green default when nothing is stored", () => {
    expect(getTheme()).toEqual({ scheme: DEFAULT_SCHEME, customColor: DEFAULT_CUSTOM_COLOR });
  });

  it("persists and reads back a preset scheme", () => {
    setTheme("red");
    expect(getTheme().scheme).toBe("red");
  });

  it("tolerates a legacy bare-string value", () => {
    localStorage.setItem("zoompaper.theme", "blue");
    expect(getTheme().scheme).toBe("blue");
  });

  it("falls back to the default on corrupted data", () => {
    localStorage.setItem("zoompaper.theme", "{not json");
    expect(getTheme().scheme).toBe(DEFAULT_SCHEME);
    localStorage.setItem("zoompaper.theme", JSON.stringify({ scheme: "neon" }));
    expect(getTheme().scheme).toBe(DEFAULT_SCHEME);
  });

  it("keeps the custom color when switching between presets", () => {
    setTheme("custom", "#123456");
    setTheme("mono");
    expect(getTheme()).toEqual({ scheme: "mono", customColor: "#123456" });
  });

  it("applyTheme sets data-scheme and inlines --primary only for custom", () => {
    applyTheme({ scheme: "dark", customColor: DEFAULT_CUSTOM_COLOR });
    expect(document.documentElement.dataset.scheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("");

    applyTheme({ scheme: "custom", customColor: "#123456" });
    expect(document.documentElement.dataset.scheme).toBe("custom");
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#123456");
    // 深色主色 → 白色按钮文字
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("#ffffff");

    // 浅色主色 → 深色按钮文字
    applyTheme({ scheme: "custom", customColor: "#f5e04a" });
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("#1a1a1a");

    applyTheme({ scheme: "green", customColor: "#123456" });
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("");
  });
});


it('restores the dark class and clears it when returning to the existing default', () => {
 setTheme('dark'); expect(document.documentElement.classList.contains('dark')).toBe(true);
 setTheme('green'); expect(document.documentElement.classList.contains('dark')).toBe(false);
});
it('rejects invalid custom colors from persisted data and updates', () => {
 localStorage.setItem('zoompaper.theme',JSON.stringify({scheme:'custom',customColor:'red;bad'}));
 expect(getTheme().customColor).toBe(DEFAULT_CUSTOM_COLOR); setTheme('custom','broken');
 expect(document.documentElement.style.getPropertyValue('--primary')).toBe(DEFAULT_CUSTOM_COLOR);
});
describe("custom JSON theme", () => {
  const theme = {
    name: "测试主题",
    vars: { background: "#fdf6ec", "zp-trans-zh": "#5b4636" },
    dark: { background: "#1a1512" },
  };

  it("injects vars inline and clears them on null", () => {
    applyCustomTheme(theme, "green");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#fdf6ec");
    expect(document.documentElement.style.getPropertyValue("--zp-trans-zh")).toBe("#5b4636");

    applyCustomTheme(null, "green");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--zp-trans-zh")).toBe("");
  });

  it("applies the dark section only under the dark scheme", () => {
    applyCustomTheme(theme, "green");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#fdf6ec");

    applyCustomTheme(theme, "dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#1a1512");
  });

  it("rejects invalid keys and dangerous values", () => {
    applyCustomTheme(
      { name: "恶意", vars: { "BAD KEY": "red", "background": "url(x); } body {" } },
      "green",
    );
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--BAD KEY")).toBe("");
  });

  it("setTheme replays the JSON theme so the dark section follows the scheme", () => {
    setCustomTheme(theme);
    setTheme("dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#1a1512");

    setTheme("green");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#fdf6ec");
  });

  it("persists the full theme and tolerates corrupted cache", () => {
    setCustomTheme(theme);
    expect(getCustomTheme()?.name).toBe("测试主题");

    setCustomTheme(null);
    expect(getCustomTheme()).toBeNull();

    localStorage.setItem("zoompaper.customTheme", "{broken");
    expect(getCustomTheme()).toBeNull();
  });
});
