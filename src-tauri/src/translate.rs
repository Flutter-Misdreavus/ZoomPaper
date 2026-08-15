//! AI 翻译：论文英文 Markdown → 中文。
//!
//! 前端把英文全文切成「结构感知」的块，逐块调 [`translate_text`] 翻译成中文，再以
//! [`TranslationChunk`]（en/zh 分块对）存成 `translation.json`。对照模式在展示层把英文
//! 原文与中文全文各自按段落切分后逐段配对（见前端 `splitBlocks`），本模块只负责 prompt
//! 与调用 LLM。

use crate::ai::llm::{ChatMessage, Llm, Role};
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 翻译 system prompt：忠实翻译、保留公式/代码/图片、术语首次保留英文、直接输出、
/// 严格保持段落结构（为展示层逐段配对提供 1:1 前提）。
const TRANSLATE_PROMPT: &str = "你是一名专业的学术论文翻译。请把用户给出的英文 Markdown 段落翻译成中文。\n\n要求：\n1. 忠实、准确地翻译学术内容，保持严谨的学术语气；保持 Markdown 结构（标题、列表、表格、引用）。\n2. 所有 LaTeX 公式（$...$ / $$...$$）、代码块、图片引用 ![...](...) 必须原样保留，不翻译其中的任何内容。\n3. 专业术语首次出现时以「中文（English）」形式呈现（英文原词保留在括号内），后续出现直接用中文。\n4. 直接输出译文 Markdown 正文，不要加任何解释、寒暄，不要用代码围栏包裹输出。\n5. 严格保持段落结构：每个英文段落翻译成一个中文段落，段落之间用空行分隔；不要合并、拆分或调换段落，不要增删空行；标题、列表项、代码块、公式块各自保持独立。";

/// 一次翻译的分块对：`en` 为原文块，`zh` 为对应中文块（存 JSON 用，也是对照对齐键）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationChunk {
    pub en: String,
    pub zh: String,
}

/// 组装翻译消息：system 为翻译 prompt，user 为待翻译的英文块。
pub fn build_messages(text: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: Role::System,
            content: TRANSLATE_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: format!("以下是需要翻译的英文 Markdown 段落：\n\n{text}"),
        },
    ]
}

/// 调用 LLM 翻译一个英文块，返回中文译文。
pub async fn translate_text(llm: &Llm, text: &str) -> Result<String> {
    llm.chat(&build_messages(text)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_messages_uses_translate_prompt_and_includes_text() {
        let msgs = build_messages("Attention is all you need.");

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("翻译"));
        assert!(msgs[0].content.contains("原样保留"));
        assert!(msgs[0].content.contains("严格保持段落结构"));
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("Attention is all you need."));
    }

    #[test]
    fn translation_chunk_roundtrips_json() {
        let chunk = TranslationChunk {
            en: "## Introduction".into(),
            zh: "## 引言".into(),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        let back: TranslationChunk = serde_json::from_str(&json).unwrap();
        assert_eq!(back.en, "## Introduction");
        assert_eq!(back.zh, "## 引言");
    }
}
