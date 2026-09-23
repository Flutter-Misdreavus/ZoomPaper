import type { ProviderConfig } from "./api";

export interface ProviderTemplate {
  id: string;
  name: string;
  provider_type: string;
  base_url?: string;
  default_model: string;
  models: string[];
  description: string;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "openai",
    name: "OpenAI",
    provider_type: "openai-compat",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o-mini",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    description: "OpenAI 官方 API",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    provider_type: "anthropic",
    default_model: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-4", "claude-haiku-4"],
    description: "Anthropic Claude 系列模型",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    provider_type: "openai-compat",
    base_url: "https://api.deepseek.com",
    default_model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    description: "DeepSeek 深度求索",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    provider_type: "openai-compat",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    default_model: "gemini-2.0-flash-exp",
    models: ["gemini-2.0-flash-exp", "gemini-1.5-pro"],
    description: "Google Gemini 模型",
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容",
    provider_type: "openai-compat",
    base_url: "",
    default_model: "",
    models: [],
    description: "自定义 OpenAI 兼容 API（代理、自建服务等）",
  },
];

export function createProviderFromTemplate(
  template: ProviderTemplate,
  apiKey: string,
  customId?: string
): ProviderConfig {
  return {
    id: customId || template.id,
    name: template.name,
    provider_type: template.provider_type,
    api_key: apiKey,
    base_url: template.base_url || null,
    default_model: template.default_model,
    models: [...template.models],
    enabled: true,
  };
}
