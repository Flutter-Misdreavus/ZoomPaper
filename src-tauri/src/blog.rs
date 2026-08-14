//! AI 博客生成：论文 Markdown → 分层通俗博客。
//!
//! 三种层级（科普 / 入门 / 专业速读）对应三套 system prompt，输出结构对齐
//! 「核心问题 → 方法直觉 → 结果意义 → 局限延伸」。本模块只负责 prompt 与
//! 调用 LLM；落盘 `blog.md` 与回写 `blog_md_path` 由命令层完成。

use crate::ai::llm::{ChatMessage, Llm, Role};
use anyhow::Result;

/// 超长论文截断阈值（字符）。约 12 万字符 ≈ 3 万 token，
/// 低于 gpt-4o-mini / Claude 的上下文上限，避免越界。
const MAX_MD_CHARS: usize = 120_000;

/// 博客层级。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlogLevel {
    /// 科普版：外行也能读懂，生活化类比，规避术语。
    Popular,
    /// 入门版：面向有基础的读者（本科生 / 研究生入门）。
    Intro,
    /// 专业速读版：面向同领域研究者。
    Expert,
}

impl BlogLevel {
    /// 从字符串解析（前端传 `popular` / `intro` / `expert`）。
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "popular" => Ok(BlogLevel::Popular),
            "intro" => Ok(BlogLevel::Intro),
            "expert" => Ok(BlogLevel::Expert),
            other => anyhow::bail!("未知博客层级: {other}（可选 popular/intro/expert）"),
        }
    }

    /// 各层级的中文 system prompt。
    pub fn system_prompt(&self) -> &'static str {
        match self {
            BlogLevel::Popular => "你是一位擅长科普的科技作家，把艰深的学术论文讲给完全外行的读者听。\n\n要求：\n1. 用生活化的类比解释核心概念，尽量规避专业术语；必须用术语时，先给出通俗解释。\n2. 结构依次为：这篇论文解决了什么问题 → 用了什么巧妙的方法 → 结果意味着什么 → 局限与延伸。\n3. 语言轻松易懂，篇幅适中，直接输出 Markdown 正文（不要写「好的」等寒暄）。",
            BlogLevel::Intro => "你是一位面向研究生新生的论文导读员，帮助有基础背景的读者快速抓住论文要点。\n\n要求：\n1. 解释论文的核心贡献与方法的直觉，保留关键术语，但每个关键术语给出简洁解释。\n2. 结构依次为：核心问题 → 方法直觉 → 结果意义 → 局限与延伸。\n3. 专业但克制，直接输出 Markdown 正文（不要写寒暄）。",
            BlogLevel::Expert => "你是一位同领域资深研究者，为同行写论文速读笔记。\n\n要求：\n1. 直接、专业、精炼，不解释常识性术语。\n2. 结构依次为：核心问题 → 方法要点 → 结果与贡献 → 局限及与相关工作的关系。\n3. 指出方法的关键假设与潜在缺陷。直接输出 Markdown 正文（不要写寒暄）。",
        }
    }
}

/// 组装对话消息：system 为层级 prompt，user 为论文 Markdown 全文（超长截断）。
pub fn build_messages(level: BlogLevel, markdown: &str) -> Vec<ChatMessage> {
    let mut md = markdown.to_string();
    if md.chars().count() > MAX_MD_CHARS {
        md = md.chars().take(MAX_MD_CHARS).collect();
        md.push_str("\n\n……（论文过长，已截断）");
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: level.system_prompt().to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: format!("以下是一篇论文的 Markdown 全文，请据此撰写博客：\n\n{md}"),
        },
    ]
}

/// 调用 LLM 生成博客，返回博客 Markdown 文本。
pub async fn generate_blog(llm: &Llm, level: BlogLevel, markdown: &str) -> Result<String> {
    let messages = build_messages(level, markdown);
    llm.chat(&messages).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_messages_uses_level_prompt_and_includes_markdown() {
        let md = "# Title\n\nAbstract text.";
        let msgs = build_messages(BlogLevel::Popular, md);

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("科普"));
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("# Title"));
    }

    #[test]
    fn build_messages_truncates_long_markdown() {
        let long = "a".repeat(MAX_MD_CHARS + 100);
        let msgs = build_messages(BlogLevel::Expert, &long);
        assert!(msgs[1].content.contains("已截断"));
    }

    #[test]
    fn parse_level_accepts_known_and_rejects_unknown() {
        assert_eq!(BlogLevel::parse("popular").unwrap(), BlogLevel::Popular);
        assert_eq!(BlogLevel::parse("EXPERT").unwrap(), BlogLevel::Expert);
        assert!(BlogLevel::parse("bogus").is_err());
    }
}
