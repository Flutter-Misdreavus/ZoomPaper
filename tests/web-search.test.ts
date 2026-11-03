import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

import { isWebSearchConfigured, webSearchStatus, type ProviderConfig, type Settings } from "@/lib/api";

function provider(id: string, apiKey: string, enabled = true): ProviderConfig {
  return {
    id,
    name: id,
    provider_type: id === "anthropic" ? "anthropic" : "openai-compat",
    api_key: apiKey,
    base_url: null,
    default_model: "model",
    models: [],
    enabled,
  };
}

function settings(providerId: string, providers: ProviderConfig[]): Settings {
  return {
    providers,
    active_provider_id: "",
    mineru_api_key: "",
    paper_library_path: null,
    embedding_model: "bge-small-en-v1.5",
    web_search_provider: providerId,
    web_search_model: null,
  };
}

describe("webSearchStatus", () => {
  it("prefers DeepSeek in auto mode and falls back to Anthropic", () => {
    expect(webSearchStatus(settings("auto", [provider("deepseek", "sk-d"), provider("anthropic", "sk-a")]))).toEqual({
      configured: true,
      provider: "deepseek",
    });
    expect(webSearchStatus(settings("auto", [provider("deepseek", "sk-d", false), provider("anthropic", "sk-a")]))).toEqual({
      configured: true,
      provider: "anthropic",
    });
  });

  it("requires the explicitly selected provider to be enabled with a non-empty key", () => {
    expect(webSearchStatus(settings("deepseek", [provider("anthropic", "sk-a")]))).toEqual({
      configured: false,
      provider: null,
    });
    expect(webSearchStatus(settings("deepseek", [provider("deepseek", "   ")]))).toEqual({
      configured: false,
      provider: null,
    });
    expect(isWebSearchConfigured(settings("none", [provider("deepseek", "sk-d")]))).toBe(false);
    expect(isWebSearchConfigured(settings("anthropic", [provider("anthropic", "sk-a")]))).toBe(true);
  });
});
