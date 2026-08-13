//! 统一 LLM Provider 接口（多 Provider 抽象）。
//!
//! Phase 3（AI 博客生成 / RAG 问答）会用到。此处定义 trait 与消息类型，
//! 具体 Provider（OpenAI / Anthropic / Gemini / DeepSeek）在后续实现。

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 一条对话消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// LLM Provider 抽象。各 Provider 实现本 trait 接入。
pub trait LlmProvider {
    /// Provider 标识，如 "openai"。
    fn name(&self) -> &'static str;

    /// 流式补全（骨架阶段占位）。
    fn chat(&self, _messages: &[ChatMessage]) -> Result<String> {
        anyhow::bail!("LLM 对话尚未实现（Phase 3）")
    }
}
