//! 费曼学习法多轮对话。
//!
//! AI 扮演「聪明但陌生的本科生」，用户扮演老师讲解论文概念。上下文策略：
//! 每个新会话首轮把论文全文压成「要点笔记」（存于会话）常驻 system，
//! 每轮用 RAG 检索该论文相关段落补细节。本模块只负责 prompt 与调用 LLM；
//! 笔记与消息持久化由命令层完成。

use crate::ai::llm::{ChatMessage, Llm, Role};
use crate::db::models::SearchHit;
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 超长论文截断阈值（字符）。约 12 万字符 ≈ 3 万 token，与 blog 一致。
const MAX_MD_CHARS: usize = 120_000;

/// 要点笔记长度上限（字符），防御性截断（正常远小于此值）。
const DIGEST_MAX_CHARS: usize = 6_000;

/// 每轮检索该论文相关段落的条数。
pub const TOP_K: usize = 5;

/// 学生人格 system prompt（不含笔记，笔记由 [`build_turn_messages`] 拼接）。
const FEYNMAN_SYSTEM_PROMPT: &str = "你是一名正在学习这篇论文的本科生：聪明，但对这篇论文还比较陌生。用户将扮演「老师」，向你讲解论文里的概念。\n\n你的任务：\n1. 认真听讲，表现出求知欲，但不要显得愚蠢。\n2. 当老师的讲解含糊、跳跃或缺少直觉时，礼貌地追问，让他讲清楚。\n3. 适时请老师用类比或生活中的例子解释，帮助你建立直觉。\n4. 偶尔（不是每次都）故意表现出一个基于论文内容的小错误或误解，看老师能否发现并纠正；被纠正后要表现出「恍然大悟」。\n5. 每次回应末尾，从「简洁度、准确性、直觉性」三个维度给一句简短反馈（可指出讲得好或可改进处），自然融入对话，不要写成打分表格。\n\n要求：\n- 始终用中文，语气像求知的学生，自然、口语化、不啰嗦。\n- 一次只聚焦一个点，不要一次抛出一大堆问题。\n- 紧扣论文内容，不要编造论文里没有的东西。";

/// 生成要点笔记的 system prompt。
const DIGEST_PROMPT: &str = "你是一位精读助手。请阅读下面的论文 Markdown 全文，整理成一份结构化的「论文要点笔记」，供后续费曼学习法对话使用（AI 会扮演学生，用户扮演老师讲解概念）。\n\n笔记请包含以下部分：\n1. 核心问题：这篇论文要解决什么问题。\n2. 方法要点：核心方法/模型的直觉与关键步骤。\n3. 关键结论：最重要的结果与含义。\n4. 关键术语清单：列出重要概念，每个用一句话解释。\n\n要求：直接输出 Markdown 笔记正文，控制在 1500 字以内，不要寒暄。";

/// 教学复盘 system prompt。
const REVIEW_PROMPT: &str = "你是费曼学习法的复盘教练。下面是一段「老师（用户）教学生（AI）」的教学对话，老师讲解的是某篇论文里的概念。\n\n请评估老师讲解的质量，从以下三个维度展开：\n1. 简洁度：能否用简单语言讲清楚，有没有不必要的啰嗦或术语堆砌。\n2. 准确性：讲解是否与论文内容一致，有没有错误或含糊。\n3. 直觉性：是否给出类比/直觉，帮助真正理解，而非死记硬背。\n\n输出 Markdown：先给一个总评（两三句），再分三个维度分别点评（各点出「做得好的」和「可改进的」），最后给 2-3 条具体改进建议。语气客观、有建设性。";

/// 开场指令：AI 以学生身份主动开场（说明读到什么 + 抛出几个问题）。
const START_PROMPT: &str = "你已经通读了这篇论文（要点见上）。现在请以学生的身份开场：用一两句话说明你读到了什么、对什么最感兴趣，然后抛出 2-3 个你最想弄懂的问题，邀请老师（用户）讲解。语气自然、口语化，直接输出开场白，不要解释你正在做什么。";

/// 会话中的一条消息（持久化到 conversations.messages 的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanMessage {
    pub role: Role,
    pub content: String,
}

/// `feynman_turn` 的返回：学生回应 + 所属会话 id + 首轮生成的要点笔记（后续轮次为 None）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanTurn {
    pub conversation_id: String,
    pub reply: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// 组装生成要点笔记的消息：system 为笔记 prompt，user 为论文全文（超长截断）。
pub fn build_digest_messages(markdown: &str) -> Vec<ChatMessage> {
    let mut md = markdown.to_string();
    if md.chars().count() > MAX_MD_CHARS {
        md = md.chars().take(MAX_MD_CHARS).collect();
        md.push_str("\n\n……（论文过长，已截断）");
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: DIGEST_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: format!("以下是论文 Markdown 全文：\n\n{md}"),
        },
    ]
}

/// 生成要点笔记（异步调 LLM，并做长度上限截断）。
pub async fn generate_digest(llm: &Llm, markdown: &str) -> Result<String> {
    let messages = build_digest_messages(markdown);
    let mut digest = llm.chat(&messages).await?;
    if digest.chars().count() > DIGEST_MAX_CHARS {
        digest = digest.chars().take(DIGEST_MAX_CHARS).collect();
    }
    Ok(digest)
}

/// 把检索命中拼成「论文相关段落」文本（不带 QA 的 `[n]` 引用编号）。
pub fn build_context(hits: &[SearchHit]) -> String {
    if hits.is_empty() {
        return String::new();
    }
    let mut ctx = String::from("【论文相关段落】\n");
    for h in hits {
        // page_idx 为 0-based，展示时 +1 成人类页码
        let page = h
            .page_idx
            .map(|p| format!("第 {} 页", p + 1))
            .unwrap_or_else(|| "页码未知".to_string());
        ctx.push_str(&format!("· {} · {}：\n{}\n\n", page, h.section, h.content));
    }
    ctx
}

/// 组装「开始」开场消息：system（学生人格 + 论文要点笔记）+ 开场指令。
pub fn build_start_messages(digest: &str) -> Vec<ChatMessage> {
    let system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n【论文要点笔记】\n{digest}");
    vec![
        ChatMessage {
            role: Role::System,
            content: system,
        },
        ChatMessage {
            role: Role::User,
            content: START_PROMPT.to_string(),
        },
    ]
}

/// 压入历史消息；若历史以 assistant 开头（「开始」后无前置 user），先补占位 user，
/// 满足 Anthropic Messages API「首条须为 user」的交替要求。
fn push_history(messages: &mut Vec<ChatMessage>, history: &[FeynmanMessage]) {
    if matches!(history.first().map(|m| m.role), Some(Role::Assistant)) {
        messages.push(ChatMessage {
            role: Role::User,
            content: "开始".to_string(),
        });
    }
    for m in history {
        messages.push(ChatMessage {
            role: m.role,
            content: m.content.clone(),
        });
    }
}

/// 组装对话消息：system（学生人格 + 论文要点笔记）+ 历史 + 当前讲解（含相关段落）。
pub fn build_turn_messages(
    digest: &str,
    context: &str,
    history: &[FeynmanMessage],
    user_msg: &str,
) -> Vec<ChatMessage> {
    let system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n【论文要点笔记】\n{digest}");
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, history);
    let user_content = if context.is_empty() {
        user_msg.to_string()
    } else {
        format!("{context}\n\n{user_msg}")
    };
    messages.push(ChatMessage {
        role: Role::User,
        content: user_content,
    });
    messages
}

/// 调用 LLM 完成一轮教学对话，返回学生回应。
pub async fn turn(llm: &Llm, messages: &[ChatMessage]) -> Result<String> {
    llm.chat(messages).await
}

/// 组装教学复盘消息：system 为复盘 prompt，其后是完整教学对话历史。
pub fn build_review_messages(history: &[FeynmanMessage]) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: REVIEW_PROMPT.to_string(),
    }];
    push_history(&mut messages, history);
    messages
}

/// 调用 LLM 生成教学复盘。
pub async fn review(llm: &Llm, history: &[FeynmanMessage]) -> Result<String> {
    llm.chat(&build_review_messages(history)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(section: &str, content: &str, page: Option<i64>) -> SearchHit {
        SearchHit {
            chunk_id: 1,
            paper_id: "p1".into(),
            paper_title: "Attention".into(),
            section: section.into(),
            content: content.into(),
            page_idx: page,
            distance: 0.0,
        }
    }

    #[test]
    fn build_context_has_no_citation_numbers() {
        let hits = vec![
            hit("Method", "first chunk", Some(0)),
            hit("Results", "second chunk", None),
        ];
        let ctx = build_context(&hits);
        assert!(ctx.contains("第 1 页"));
        assert!(ctx.contains("页码未知"));
        assert!(ctx.contains("first chunk"));
        // 费曼上下文不带 QA 的 [n] 引用编号
        assert!(!ctx.contains("[1]"));
        assert!(!ctx.contains("[2]"));
    }

    #[test]
    fn build_context_empty_returns_empty() {
        assert_eq!(build_context(&[]), "");
    }

    #[test]
    fn build_turn_messages_has_system_digest_history_and_context() {
        let history = vec![
            FeynmanMessage {
                role: Role::User,
                content: "我来教你注意力".into(),
            },
            FeynmanMessage {
                role: Role::Assistant,
                content: "什么是注意力？".into(),
            },
        ];
        let msgs = build_turn_messages("要点笔记", "【论文相关段落】\n· 第 2 页 · Method：…", &history, "注意力就是…");
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("本科生"));
        assert!(msgs[0].content.contains("要点笔记"));
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].role, Role::User);
        assert!(msgs[3].content.contains("【论文相关段落】"));
        assert!(msgs[3].content.contains("注意力就是…"));
    }

    #[test]
    fn build_turn_messages_without_context_omits_block() {
        let msgs = build_turn_messages("要点", "", &[], "直接讲解");
        assert_eq!(msgs[1].content, "直接讲解");
    }

    #[test]
    fn build_digest_messages_includes_markdown_and_truncates() {
        let msgs = build_digest_messages("# Title\n\nBody");
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("精读助手"));
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("# Title"));

        let long = "a".repeat(MAX_MD_CHARS + 100);
        let msgs = build_digest_messages(&long);
        assert!(msgs[1].content.contains("已截断"));
    }

    #[test]
    fn build_review_messages_has_system_and_history() {
        let history = vec![FeynmanMessage {
            role: Role::User,
            content: "我来讲".into(),
        }];
        let msgs = build_review_messages(&history);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("复盘"));
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "我来讲");
    }

    #[test]
    fn build_start_messages_has_persona_digest_and_start_prompt() {
        let msgs = build_start_messages("要点笔记");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("本科生"));
        assert!(msgs[0].content.contains("要点笔记"));
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("开场"));
    }

    #[test]
    fn build_turn_messages_prepends_user_when_history_starts_with_assistant() {
        let history = vec![FeynmanMessage {
            role: Role::Assistant,
            content: "我读完了，有几个问题…".into(),
        }];
        let msgs = build_turn_messages("要点", "", &history, "我来教你");
        // [system, 占位user, assistant开场, user讲解]
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].role, Role::User);
        assert_eq!(msgs[3].content, "我来教你");
    }

    #[test]
    fn build_review_messages_prepends_user_when_history_starts_with_assistant() {
        let history = vec![FeynmanMessage {
            role: Role::Assistant,
            content: "开场白".into(),
        }];
        let msgs = build_review_messages(&history);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
    }
}
