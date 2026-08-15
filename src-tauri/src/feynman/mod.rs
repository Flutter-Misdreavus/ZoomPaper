//! 费曼学习法多轮对话。
//!
//! AI 扮演「聪明但陌生的本科生」，用户扮演老师讲解论文概念。上下文策略（无要点笔记，
//! 纯检索驱动）：论文结构以「章节地图（TOC）」常驻 system，每轮用 RAG 命中的相关章节
//! 全文补细节；历史用「滚动窗口 + 教学进展摘要」控 token（旧轮次在线压缩）。本模块只
//! 负责 prompt 与调用 LLM；摘要与消息持久化由命令层完成。

use crate::ai::llm::{ChatMessage, Llm, Role};
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 每轮发给 LLM 的原始历史消息条数上限（窗口）；更早的轮次压缩为摘要。
pub const WINDOW_MAX_MSGS: usize = 10;

/// 「教学进展」摘要长度上限（字符），防御性截断。
const SUMMARY_MAX_CHARS: usize = 1500;

/// 章节地图 TOC 最多列出的章节数（其余省略）。
const TOC_MAX_SECTIONS: usize = 30;

/// 每轮检索该论文相关段落的条数。
pub const TOP_K: usize = 5;

/// 每轮升级为「章节级全文」的最多章节数。
pub const MAX_SECTIONS: usize = 2;

/// 单个章节全文的长度上限（字符）。
pub const SECTION_MAX_CHARS: usize = 8000;

/// 章节级上下文总长度上限（字符）。
pub const SECTION_CTX_TOTAL_MAX: usize = 12000;

/// 首轮「通读全文」的字符上限（超长截断，防御性）。
pub const FULL_PAPER_MAX_CHARS: usize = 120_000;

/// 学生人格 system prompt（不含论文内容，论文结构/摘要由组装函数拼接）。
const FEYNMAN_SYSTEM_PROMPT: &str = "你是一名正在学习这篇论文的本科生：聪明，但对这篇论文还比较陌生。用户将扮演「老师」，向你讲解论文里的概念。\n\n你的任务：\n1. 认真听讲，表现出求知欲，但不要显得愚蠢。\n2. 当老师的讲解含糊、跳跃或缺少直觉时，礼貌地追问，让他讲清楚。\n3. 适时请老师用类比或生活中的例子解释，帮助你建立直觉。\n4. 偶尔（不是每次都）故意表现出一个基于论文内容的小错误或误解，看老师能否发现并纠正；被纠正后要表现出「恍然大悟」。\n5. 每次回应末尾，从「简洁度、准确性、直觉性」三个维度给一句简短反馈（可指出讲得好或可改进处），自然融入对话，不要写成打分表格。\n\n要求：\n- 始终用中文，语气像求知的学生，自然、口语化、不啰嗦。\n- 一次只聚焦一个点，不要一次抛出一大堆问题。\n- 紧扣论文内容，不要编造论文里没有的东西。";

/// 教学复盘 system prompt。
const REVIEW_PROMPT: &str = "你是费曼学习法的复盘教练。下面是一段「老师（用户）教学生（AI）」的教学对话，老师讲解的是某篇论文里的概念。\n\n请评估老师讲解的质量，从以下三个维度展开：\n1. 简洁度：能否用简单语言讲清楚，有没有不必要的啰嗦或术语堆砌。\n2. 准确性：讲解是否与论文内容一致，有没有错误或含糊。\n3. 直觉性：是否给出类比/直觉，帮助真正理解，而非死记硬背。\n\n输出 Markdown：先给一个总评（两三句），再分三个维度分别点评（各点出「做得好的」和「可改进的」），最后给 2-3 条具体改进建议。语气客观、有建设性。";

/// 开场指令：AI 以学生身份基于已通读的论文全文主动开场。
const START_PROMPT: &str = "你已经通读了这篇论文的全文。现在请以学生的身份开场：结合论文的实际内容，说说你读到了什么、对哪些方法或结论最感兴趣、最想弄懂什么，然后抛出 2-3 个问题邀请老师（用户）讲解。语气自然、口语化，直接输出开场白，不要解释你正在做什么。";

/// 压缩「教学进展」摘要的 system prompt：把旧摘要与新滑出窗口的消息合并更新。
const SUMMARY_PROMPT: &str = "你正在整理一段费曼学习法教学对话的「进展摘要」。用户是老师，AI 是学生。\n\n请把对话压缩成一份 Markdown 摘要（3-5 条要点），记录：已经讲了哪些概念、学生当前的疑问、老师讲解中值得延续或待补充的地方。若消息中提供了已有摘要，请把它与新增对话合并更新，不要丢失关键信息。\n\n要求：直接输出摘要正文，控制在 350 字以内，不要寒暄。";

/// 会话中的一条消息（持久化到 conversations.messages 的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanMessage {
    pub role: Role,
    pub content: String,
}

/// `feynman_turn` 的返回：学生回应 + 所属会话 id。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanTurn {
    pub conversation_id: String,
    pub reply: String,
}

/// 组装章节地图：`【论文章节】\n- {name}`，节名截断 ≤60 字符、至多 `TOC_MAX_SECTIONS` 条。
pub fn build_toc(sections: &[String]) -> String {
    if sections.is_empty() {
        return String::new();
    }
    let mut out = String::from("【论文章节】\n");
    for s in sections.iter().take(TOC_MAX_SECTIONS) {
        let name: String = s.chars().take(60).collect();
        out.push_str(&format!("- {name}\n"));
    }
    if sections.len() > TOC_MAX_SECTIONS {
        out.push_str(&format!(
            "- ……（共 {} 节，仅列出前 {TOC_MAX_SECTIONS} 节）\n",
            sections.len()
        ));
    }
    out
}

/// 拼「论文全文」块（首轮通读用）：截断到 `FULL_PAPER_MAX_CHARS` 后加 `【论文全文】` 前缀。
pub fn build_full_paper(md: &str) -> String {
    let mut s = md.to_string();
    if s.chars().count() > FULL_PAPER_MAX_CHARS {
        s = s.chars().take(FULL_PAPER_MAX_CHARS).collect();
        s.push_str("\n\n……（论文过长，已截断）");
    }
    format!("【论文全文】\n{s}")
}

/// 把选中的章节全文拼成上下文：`【论文相关章节】\n### {section}\n{text}`。
pub fn build_section_context(sections: &[(String, String)]) -> String {
    if sections.is_empty() {
        return String::new();
    }
    let mut ctx = String::from("【论文相关章节】\n");
    for (section, text) in sections {
        ctx.push_str(&format!("### {section}\n{text}\n\n"));
    }
    ctx
}

/// 把完整历史切成「滑出部分（overflow，将被压缩成摘要）+ 最近窗口（window，原样保留）」。
/// 历史长度不超过窗口时 overflow 为空。
pub fn split_window(
    history: &[FeynmanMessage],
    max_msgs: usize,
) -> (Vec<FeynmanMessage>, Vec<FeynmanMessage>) {
    if history.len() <= max_msgs {
        return (Vec::new(), history.to_vec());
    }
    let n = history.len() - max_msgs;
    (history[..n].to_vec(), history[n..].to_vec())
}

/// 组装压缩摘要的消息：system 为压缩 prompt；user 为「已有摘要（若有）+ 新滑出的消息」。
pub fn build_summary_messages(
    existing: Option<&str>,
    overflow: &[FeynmanMessage],
) -> Vec<ChatMessage> {
    let mut content = String::new();
    if let Some(ex) = existing {
        if !ex.trim().is_empty() {
            content.push_str("【已有摘要】\n");
            content.push_str(ex);
            content.push('\n');
        }
    }
    content.push_str("【新增对话】\n");
    for m in overflow {
        let role_label = match m.role {
            Role::User => "老师",
            Role::Assistant => "学生",
            Role::System => "系统",
        };
        content.push_str(&format!("{role_label}：{}\n\n", m.content));
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: SUMMARY_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content,
        },
    ]
}

/// 调 LLM 把「旧摘要 + 滑出消息」压缩成新摘要，并做长度上限截断。
pub async fn roll_summary(
    llm: &Llm,
    existing: Option<&str>,
    overflow: &[FeynmanMessage],
) -> Result<String> {
    let mut summary = llm.chat(&build_summary_messages(existing, overflow)).await?;
    if summary.chars().count() > SUMMARY_MAX_CHARS {
        summary = summary.chars().take(SUMMARY_MAX_CHARS).collect();
    }
    Ok(summary)
}

/// 组装「开始」开场消息：system（学生人格 + 章节地图 + 论文全文）+ 开场指令。
pub fn build_start_messages(toc: &str, full_paper: &str) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if !full_paper.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(full_paper);
    }
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

/// 组装对话消息：system（学生人格 + 章节地图 + [首轮论文全文] + 教学进展摘要）+ 窗口历史 +
/// 当前讲解（含相关章节）。`full_paper` 仅在首轮传入，后续轮次为 `None`。
pub fn build_turn_messages(
    toc: &str,
    full_paper: Option<&str>,
    summary: Option<&str>,
    context: &str,
    window: &[FeynmanMessage],
    user_msg: &str,
) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if let Some(fp) = full_paper {
        if !fp.trim().is_empty() {
            system.push_str("\n\n");
            system.push_str(fp);
        }
    }
    if let Some(s) = summary {
        if !s.trim().is_empty() {
            system.push_str("\n\n【教学进展】\n");
            system.push_str(s);
        }
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
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

/// 组装教学复盘消息：system 为复盘 prompt（附教学进展摘要），其后是窗口内的对话。
pub fn build_review_messages(summary: Option<&str>, window: &[FeynmanMessage]) -> Vec<ChatMessage> {
    let mut system = REVIEW_PROMPT.to_string();
    if let Some(s) = summary {
        if !s.trim().is_empty() {
            system.push_str("\n\n【教学进展摘要】\n");
            system.push_str(s);
        }
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    messages
}

/// 调用 LLM 生成教学复盘。
pub async fn review(
    llm: &Llm,
    summary: Option<&str>,
    window: &[FeynmanMessage],
) -> Result<String> {
    llm.chat(&build_review_messages(summary, window)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: Role, content: &str) -> FeynmanMessage {
        FeynmanMessage {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn build_toc_formats_and_caps_sections() {
        // 空 → 空字符串
        assert_eq!(build_toc(&[]), "");

        // 超长节名截断到 60 字符
        let long = "x".repeat(100);
        let toc = build_toc(&[long]);
        assert!(toc.starts_with("【论文章节】\n- "));
        assert!(toc.contains(&"x".repeat(60)));
        assert!(!toc.contains(&"x".repeat(61)));

        // 超过 TOC_MAX_SECTIONS → 省略提示
        let many: Vec<String> = (0..TOC_MAX_SECTIONS + 5)
            .map(|i| format!("Sec {i}"))
            .collect();
        let toc = build_toc(&many);
        assert_eq!(toc.matches("- Sec ").count(), TOC_MAX_SECTIONS);
        assert!(toc.contains("仅列出前"));
    }

    #[test]
    fn build_section_context_formats_sections() {
        assert_eq!(build_section_context(&[]), "");
        let ctx = build_section_context(&[
            ("Method".into(), "核心方法正文".into()),
            ("Results".into(), "结果正文".into()),
        ]);
        assert!(ctx.starts_with("【论文相关章节】\n"));
        assert!(ctx.contains("### Method\n核心方法正文"));
        assert!(ctx.contains("### Results\n结果正文"));
    }

    #[test]
    fn split_window_partitions_history() {
        let hist: Vec<FeynmanMessage> = (0..12).map(|i| msg(Role::User, &i.to_string())).collect();

        // 不足窗口 → overflow 空，window 全量
        let (o, w) = split_window(&hist[..5], 10);
        assert!(o.is_empty());
        assert_eq!(w.len(), 5);

        // 超过窗口 → overflow 前 n，window 后 10
        let (o, w) = split_window(&hist, 10);
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].content, "0");
        assert_eq!(w.len(), 10);
        assert_eq!(w[0].content, "2");
    }

    #[test]
    fn build_summary_messages_includes_existing_and_overflow() {
        let overflow = vec![
            msg(Role::User, "我来教你注意力"),
            msg(Role::Assistant, "什么是注意力？"),
        ];
        let msgs = build_summary_messages(Some("旧摘要：讲了 Transformer"), &overflow);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("进展摘要"));
        assert!(msgs[1].content.contains("【已有摘要】"));
        assert!(msgs[1].content.contains("旧摘要"));
        assert!(msgs[1].content.contains("【新增对话】"));
        assert!(msgs[1].content.contains("老师：我来教你注意力"));
        assert!(msgs[1].content.contains("学生：什么是注意力？"));

        // 无旧摘要 → 只含新增对话
        let msgs = build_summary_messages(None, &overflow);
        assert!(!msgs[1].content.contains("已有摘要"));
        assert!(msgs[1].content.contains("新增对话"));
    }

    #[test]
    fn build_full_paper_truncates_long_markdown() {
        let short = build_full_paper("# Title\nbody");
        assert!(short.starts_with("【论文全文】"));
        assert!(short.contains("# Title"));

        let long = "a".repeat(FULL_PAPER_MAX_CHARS + 100);
        let out = build_full_paper(&long);
        assert!(out.contains("已截断"));
        assert!(out.chars().count() < FULL_PAPER_MAX_CHARS + 200);
    }

    #[test]
    fn build_start_messages_has_persona_toc_fullpaper_and_start_prompt() {
        let msgs = build_start_messages(
            "【论文章节】\n- Intro\n- Method",
            "【论文全文】\n# Attention Is All You Need\n正文…",
        );
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("本科生"));
        assert!(msgs[0].content.contains("论文章节"));
        assert!(msgs[0].content.contains("Method"));
        assert!(msgs[0].content.contains("论文全文"));
        assert!(msgs[0].content.contains("Attention Is All You Need"));
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("通读了这篇论文的全文"));
        assert!(msgs[1].content.contains("开场"));
    }

    #[test]
    fn build_turn_messages_has_system_toc_fullpaper_summary_window_and_context() {
        let window = vec![
            msg(Role::User, "我来教你注意力"),
            msg(Role::Assistant, "什么是注意力？"),
        ];
        let msgs = build_turn_messages(
            "【论文章节】\n- Method",
            Some("【论文全文】\n正文…"),
            Some("讲了注意力机制"),
            "【论文相关章节】\n### Method\n…",
            &window,
            "注意力就是…",
        );
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("本科生"));
        assert!(msgs[0].content.contains("论文章节"));
        assert!(msgs[0].content.contains("论文全文"));
        assert!(msgs[0].content.contains("教学进展"));
        assert!(msgs[0].content.contains("讲了注意力机制"));
        // 已删除要点笔记，system 不应再包含笔记注入
        assert!(!msgs[0].content.contains("要点笔记"));
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].role, Role::User);
        assert!(msgs[3].content.contains("【论文相关章节】"));
        assert!(msgs[3].content.contains("注意力就是…"));

        // 非首轮（full_paper=None）→ system 不含全文块
        let msgs = build_turn_messages("【论文章节】\n- Method", None, None, "", &[], "继续");
        assert!(!msgs[0].content.contains("论文全文"));
    }

    #[test]
    fn build_turn_messages_without_context_omits_block() {
        let msgs = build_turn_messages("", None, None, "", &[], "直接讲解");
        assert_eq!(msgs[1].content, "直接讲解");
    }

    #[test]
    fn build_turn_messages_prepends_user_when_window_starts_with_assistant() {
        let window = vec![msg(Role::Assistant, "开场白")];
        let msgs = build_turn_messages("", None, None, "", &window, "我来教你");
        // [system, 占位user, assistant开场, user讲解]
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].content, "我来教你");
    }

    #[test]
    fn build_review_messages_has_system_summary_and_window() {
        let window = vec![msg(Role::User, "我来讲")];
        let msgs = build_review_messages(Some("讲了注意力"), &window);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("复盘"));
        assert!(msgs[0].content.contains("教学进展摘要"));
        assert!(msgs[0].content.contains("讲了注意力"));
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "我来讲");
    }

    #[test]
    fn build_review_messages_prepends_user_when_window_starts_with_assistant() {
        let window = vec![msg(Role::Assistant, "开场白")];
        let msgs = build_review_messages(None, &window);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
    }
}
