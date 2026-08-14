//! 统一 LLM 对话接口（多 Provider）。
//!
//! 通过 [`Llm`] 枚举分发到两类请求格式：
//! - **OpenAI 兼容**（openai / deepseek / gemini 共用 `chat/completions`，仅 base URL 与鉴权不同）
//! - **Anthropic**（独立 Messages API，system 单独放顶层字段）
//!
//! 具体 provider 与 API Key 由 [`crate::settings::Settings`] 决定（设置页填写）。

use crate::settings::Settings;
use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Anthropic Messages API 要求显式 `max_tokens`。
const ANTHROPIC_MAX_TOKENS: u32 = 8192;

/// 一条对话消息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// 一个可用的 LLM Provider。
pub enum Llm {
    /// OpenAI 兼容接口（openai / deepseek / gemini 兼容端点）。
    OpenAiCompat {
        base_url: String,
        api_key: String,
        model: String,
    },
    /// Anthropic Messages API。
    Anthropic { api_key: String, model: String },
}

impl Llm {
    /// 按 settings 的 `llm_provider` 选择 provider 并取对应 API Key（为空则报错）。
    pub fn from_settings(s: &Settings) -> Result<Llm> {
        let model = s.llm_model.clone();
        match s.llm_provider.to_lowercase().as_str() {
            "openai" => {
                let key = s.api_keys.openai.clone();
                if key.is_empty() {
                    anyhow::bail!("未配置 OpenAI API Key，请先在设置页填写");
                }
                Ok(Llm::OpenAiCompat {
                    base_url: "https://api.openai.com/v1".into(),
                    api_key: key,
                    model,
                })
            }
            "deepseek" => {
                let key = s.api_keys.deepseek.clone();
                if key.is_empty() {
                    anyhow::bail!("未配置 DeepSeek API Key，请先在设置页填写");
                }
                Ok(Llm::OpenAiCompat {
                    base_url: "https://api.deepseek.com".into(),
                    api_key: key,
                    model,
                })
            }
            "gemini" => {
                let key = s.api_keys.gemini.clone();
                if key.is_empty() {
                    anyhow::bail!("未配置 Gemini API Key，请先在设置页填写");
                }
                Ok(Llm::OpenAiCompat {
                    base_url: "https://generativelanguage.googleapis.com/v1beta/openai".into(),
                    api_key: key,
                    model,
                })
            }
            "anthropic" => {
                let key = s.api_keys.anthropic.clone();
                if key.is_empty() {
                    anyhow::bail!("未配置 Anthropic API Key，请先在设置页填写");
                }
                Ok(Llm::Anthropic { api_key: key, model })
            }
            other => anyhow::bail!("未知 LLM provider: {other}"),
        }
    }

    /// 发送多轮对话，返回助手回复文本。
    pub async fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        match self {
            Llm::OpenAiCompat {
                base_url,
                api_key,
                model,
            } => {
                let resp = Client::new()
                    .post(format!("{base_url}/chat/completions"))
                    .bearer_auth(api_key)
                    .json(&openai_body(model, messages))
                    .send()
                    .await
                    .context("调用 OpenAI 兼容接口失败")?;
                let status = resp.status();
                let body: serde_json::Value = resp.json().await.context("解析 LLM 响应失败")?;
                if !status.is_success() {
                    anyhow::bail!("LLM 返回错误 {status}: {body}");
                }
                body["choices"][0]["message"]["content"]
                    .as_str()
                    .context("LLM 响应缺少 content")
                    .map(str::to_string)
            }
            Llm::Anthropic { api_key, model } => {
                let resp = Client::new()
                    .post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&anthropic_body(model, messages))
                    .send()
                    .await
                    .context("调用 Anthropic 接口失败")?;
                let status = resp.status();
                let body: serde_json::Value = resp.json().await.context("解析 LLM 响应失败")?;
                if !status.is_success() {
                    anyhow::bail!("LLM 返回错误 {status}: {body}");
                }
                body["content"][0]["text"]
                    .as_str()
                    .context("Anthropic 响应缺少 content")
                    .map(str::to_string)
            }
        }
    }
}

/// 构造 OpenAI 兼容请求体（`chat/completions`）。
fn openai_body(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    json!({ "model": model, "messages": msgs })
}

/// 构造 Anthropic 请求体（`messages`）：system 拆到顶层，messages 只留 user/assistant。
fn anthropic_body(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let system = messages
        .iter()
        .filter(|m| m.role == Role::System)
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != Role::System)
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": system,
        "messages": msgs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: Role, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn openai_body_keeps_all_messages() {
        let msgs = vec![
            msg(Role::System, "sys"),
            msg(Role::User, "hi"),
            msg(Role::Assistant, "hello"),
        ];
        let body = openai_body("gpt-4o-mini", &msgs);
        assert_eq!(body["model"], "gpt-4o-mini");
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["role"], "system");
        assert_eq!(arr[1]["content"], "hi");
    }

    #[test]
    fn anthropic_body_splits_system_and_keeps_user_assistant() {
        let msgs = vec![
            msg(Role::System, "sys prompt"),
            msg(Role::User, "hi"),
            msg(Role::Assistant, "hello"),
        ];
        let body = anthropic_body("claude-sonnet-4-6", &msgs);
        assert_eq!(body["model"], "claude-sonnet-4-6");
        assert_eq!(body["system"], "sys prompt");
        assert!(body["max_tokens"].is_u64());
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[1]["role"], "assistant");
    }

    #[test]
    fn from_settings_requires_key_and_picks_base_url() {
        let mut s = Settings::default();
        s.llm_provider = "openai".to_string();
        assert!(Llm::from_settings(&s).is_err()); // 空 key 应报错

        s.api_keys.openai = "sk-test".into();
        match Llm::from_settings(&s).unwrap() {
            Llm::OpenAiCompat {
                base_url, api_key, ..
            } => {
                assert!(base_url.contains("openai.com"));
                assert_eq!(api_key, "sk-test");
            }
            _ => panic!("应为 OpenAiCompat"),
        }
    }

    #[test]
    fn from_settings_unknown_provider_errors() {
        let mut s = Settings::default();
        s.llm_provider = "nope".into();
        assert!(Llm::from_settings(&s).is_err());
    }
}
