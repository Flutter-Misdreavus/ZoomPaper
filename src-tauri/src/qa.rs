//! RAG 知识库问答：检索 → 组装上下文 → LLM 带引用回答。
//!
//! 复用 [`crate::rag::search`] 取 Top-K 段落、[`crate::ai::llm::Llm`] 生成回答；
//! 回答文本用 `[n]` 标注引用，结构化引用见 [`Citation`]。会话持久化由命令层完成。

use crate::ai::llm::{ChatMessage, Llm, Role};
use crate::db::models::SearchHit;
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// RAG 问答 system prompt：只依据上下文，用 [n] 标注引用，缺失则明说。
const QA_SYSTEM_PROMPT: &str = "你是一个论文知识库问答助手。\n\n规则：\n1. 只依据下面提供的【上下文资料】回答，引用某段资料时用 [n] 标注（n 为该资料的编号）。\n2. 资料里没有的信息就明确说「资料中没有相关信息」，不要编造。\n3. 用中文回答，简洁准确。";

/// 引用 snippet 截断长度（字符）。
const SNIPPET_CHARS: usize = 200;

/// 一条引用：回答中 `[index]` 对应的原文出处。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Citation {
    pub index: usize,
    pub chunk_id: i64,
    pub paper_id: String,
    pub paper_title: String,
    pub section: String,
    pub page_idx: Option<i64>,
    pub snippet: String,
}

/// 会话中的一条消息（持久化到 conversations.messages 的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaMessage {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<Citation>>,
}

/// `ask_question` 的返回：回答 + 引用 + 所属会话 id。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub conversation_id: String,
    pub answer: String,
    pub citations: Vec<Citation>,
}

/// 按字符数截断（超长补省略号）。`pub(crate)` 供命令层截会话标题复用。
pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// 把检索命中组装成编号上下文文本。
pub fn build_context(hits: &[SearchHit]) -> String {
    let mut ctx = String::from("【上下文资料】\n");
    for (i, h) in hits.iter().enumerate() {
        // page_idx 为 0-based（content_list 约定），展示时 +1 成人类页码
        let page = h
            .page_idx
            .map(|p| format!("第 {} 页", p + 1))
            .unwrap_or_else(|| "页码未知".to_string());
        ctx.push_str(&format!(
            "[{}] 论文《{}》· {} · {}：\n{}\n\n",
            i + 1,
            h.paper_title,
            page,
            h.section,
            h.content
        ));
    }
    ctx
}

/// 组装对话消息：system + 历史轮次 + 当前问题（含上下文）。
pub fn build_messages(question: &str, context: &str, history: &[QaMessage]) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: QA_SYSTEM_PROMPT.to_string(),
    }];
    for m in history {
        messages.push(ChatMessage {
            role: m.role,
            content: m.content.clone(),
        });
    }
    messages.push(ChatMessage {
        role: Role::User,
        content: format!("{context}\n\n问题：{question}"),
    });
    messages
}

/// 从检索命中生成结构化引用（index 从 1 编号）。
pub fn citations_from_hits(hits: &[SearchHit]) -> Vec<Citation> {
    hits.iter()
        .enumerate()
        .map(|(i, h)| Citation {
            index: i + 1,
            chunk_id: h.chunk_id,
            paper_id: h.paper_id.clone(),
            paper_title: h.paper_title.clone(),
            section: h.section.clone(),
            page_idx: h.page_idx,
            snippet: truncate(&h.content, SNIPPET_CHARS),
        })
        .collect()
}

/// 检索 + 组装的产物：LLM 输入消息与结构化引用。
pub struct Prepared {
    pub messages: Vec<ChatMessage>,
    pub citations: Vec<Citation>,
    pub empty: bool,
}

/// 检索 + 组装（纯 DB 阶段，无 await，故可安全持有 `&Connection`）。
pub fn prepare(
    conn: &Connection,
    question: &str,
    paper_id: Option<&str>,
    history: &[QaMessage],
    top_k: usize,
) -> Result<Prepared> {
    let hits = crate::rag::search(conn, question, top_k, paper_id)?;
    if hits.is_empty() {
        return Ok(Prepared {
            messages: Vec::new(),
            citations: Vec::new(),
            empty: true,
        });
    }
    let context = build_context(&hits);
    Ok(Prepared {
        messages: build_messages(question, &context, history),
        citations: citations_from_hits(&hits),
        empty: false,
    })
}

/// 用组装好的消息调 LLM（异步阶段，不持有 `&Connection`，保证 future 可 `Send`）。
pub async fn ask(llm: &Llm, prepared: &Prepared) -> Result<(String, Vec<Citation>)> {
    if prepared.empty {
        return Ok((
            "未检索到相关内容，请确认论文已解析并完成索引。".to_string(),
            Vec::new(),
        ));
    }
    let answer = llm.chat(&prepared.messages).await?;
    Ok((answer, prepared.citations.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(title: &str, section: &str, content: &str, page: Option<i64>) -> SearchHit {
        SearchHit {
            chunk_id: 1,
            paper_id: "p1".into(),
            paper_title: title.into(),
            section: section.into(),
            content: content.into(),
            page_idx: page,
            distance: 0.0,
        }
    }

    #[test]
    fn build_context_numbers_and_labels() {
        let hits = vec![
            hit("Attention", "Introduction", "first chunk", Some(0)),
            hit("GPT", "Method", "second chunk", None),
        ];
        let ctx = build_context(&hits);
        assert!(ctx.contains("[1]"));
        assert!(ctx.contains("[2]"));
        assert!(ctx.contains("《Attention》"));
        assert!(ctx.contains("第 1 页"));
        assert!(ctx.contains("页码未知"));
    }

    #[test]
    fn build_messages_has_system_history_and_question() {
        let history = vec![
            QaMessage {
                role: Role::User,
                content: "什么是注意力？".into(),
                citations: None,
            },
            QaMessage {
                role: Role::Assistant,
                content: "注意力是…".into(),
                citations: None,
            },
        ];
        let msgs = build_messages("它为何有效？", "【上下文资料】\n[1] …", &history);
        assert_eq!(msgs[0].role, Role::System);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "什么是注意力？");
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].role, Role::User);
        assert!(msgs[3].content.contains("它为何有效？"));
        assert!(msgs[3].content.contains("【上下文资料】"));
    }

    #[test]
    fn citations_from_hits_indexes_and_truncates() {
        let long = "x".repeat(300);
        let hits = vec![hit("T", "S", &long, Some(2))];
        let cits = citations_from_hits(&hits);
        assert_eq!(cits.len(), 1);
        assert_eq!(cits[0].index, 1);
        assert_eq!(cits[0].page_idx, Some(2));
        // 截断到 SNIPPET_CHARS 字符 + 一个省略号
        assert_eq!(cits[0].snippet.chars().count(), SNIPPET_CHARS + 1);
    }
}
