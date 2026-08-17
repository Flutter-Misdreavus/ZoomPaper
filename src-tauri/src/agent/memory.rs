//! 会话级工具记忆：跨轮复用已查证的研究结果。
//!
//! 每条记忆是「定位索引」式条目（论文标题/页码/章节 + snippet，或联网 URL），
//! 由已完成轮次的引用与工具轨迹**确定性**生成（零 LLM 调用）。记忆总量超限时
//! 才调用一次 LLM 合并压缩（借鉴费曼 `roll_summary` 模式）；LLM 失败则丢最旧。
//!
//! 记忆注入下一轮 system prompt 的「研究记忆」段，**不带编号引用**（避免与当前轮
//! `[n]` 冲突）：模型据此直接定位来源，需要精确引用时用工具快速取回原文。

use crate::ai::llm::{AgentMsg, ChatMessage, LlmChat, Role};
use crate::qa::{truncate, Citation};
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 记忆最多保留条目数（超出触发压缩）。
pub const MEMORY_MAX_ENTRIES: usize = 6;
/// 记忆总字符上限（超出触发压缩）。
pub const MEMORY_MAX_CHARS: usize = 2500;
/// 单条记忆条目字符上限。
pub const MEMORY_ENTRY_MAX_CHARS: usize = 600;
/// 合并压缩后单条记忆的字符上限。
const COMPRESSED_MAX_CHARS: usize = 800;
/// 引用 snippet 收录长度。
const SNIPPET_CHARS: usize = 120;

/// 一条研究记忆。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub text: String,
    /// unix 秒
    pub at: i64,
}

/// 从已完成轮次构建确定性记忆条目（无本地引用且无联网步骤时返回空串）。
pub fn build_memory_entry(question: &str, citations: &[Citation], trace: &[super::ToolStep]) -> String {
    let mut parts: Vec<String> = Vec::new();
    // 本地引用：按 (paper_id, section, page) 去重，取前 6 条
    let mut seen = std::collections::HashSet::new();
    for c in citations {
        let key = (c.paper_id.as_str(), c.section.as_str(), c.page_idx);
        if !seen.insert(key) {
            continue;
        }
        let page = c
            .page_idx
            .map(|p| format!("第 {} 页", p + 1))
            .unwrap_or_else(|| "页码未知".to_string());
        parts.push(format!(
            "论文《{}》· {} · {}：{}",
            c.paper_title,
            page,
            c.section,
            truncate(&c.snippet, SNIPPET_CHARS)
        ));
        if parts.len() >= 6 {
            break;
        }
    }
    // 联网步骤（web_search / web_fetch 的 summary 含来源 URL）
    for step in trace {
        if matches!(step.name.as_str(), "web_search" | "web_fetch") && !step.summary.is_empty() {
            parts.push(format!("联网：{}", truncate(&step.summary, SNIPPET_CHARS)));
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    let mut text = format!("问题：{}\n", truncate(question, 60));
    text.push_str(&parts.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n"));
    truncate(&text, MEMORY_ENTRY_MAX_CHARS)
}

/// 追加一条记忆并执行压缩：总字符或条目数超限 → LLM 合并压缩为一条；失败则丢最旧。
pub async fn append_memory<L: LlmChat>(
    llm: &L,
    mut entries: Vec<MemoryEntry>,
    new_text: String,
    now: i64,
) -> Vec<MemoryEntry> {
    let new_text = new_text.trim();
    if new_text.is_empty() {
        return entries;
    }
    entries.push(MemoryEntry {
        text: new_text.to_string(),
        at: now,
    });
    let total: usize = entries.iter().map(|e| e.text.chars().count()).sum();
    if entries.len() <= MEMORY_MAX_ENTRIES && total <= MEMORY_MAX_CHARS {
        return entries;
    }
    // 超限：LLM 合并压缩全部条目
    match compress_memory(llm, &entries).await {
        Ok(text) if !text.trim().is_empty() => vec![MemoryEntry {
            text: truncate(text.trim(), COMPRESSED_MAX_CHARS),
            at: now,
        }],
        // LLM 失败或产出为空：丢弃最旧，保留最新
        _ => {
            while entries.len() > MEMORY_MAX_ENTRIES {
                entries.remove(0);
            }
            entries
        }
    }
}

/// LLM 把多轮记忆合并压缩成一条（保留来源定位，去掉编号与冗余）。
async fn compress_memory<L: LlmChat>(llm: &L, entries: &[MemoryEntry]) -> Result<String> {
    let body = entries
        .iter()
        .map(|e| e.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let messages = vec![
        AgentMsg::Plain(ChatMessage {
            role: Role::System,
            content: "你是论文研究助手的研究记录员。下面是一份论文问答会话的多轮「研究记忆」\
             （每轮记录该轮已查证的事实与来源定位）。请把它们合并压缩成一份更精炼的记忆：\
             按主题归类，保留每一条的来源定位（论文标题/页码/章节、或网页 URL），\
             去掉重复信息与轮次编号。直接输出压缩后的正文，800 字以内，不要寒暄。"
                .to_string(),
        }),
        AgentMsg::Plain(ChatMessage {
            role: Role::User,
            content: body,
        }),
    ];
    let resp = llm.chat_with_tools(&messages, &[]).await?;
    Ok(resp.content.unwrap_or_default())
}

/// 把记忆列表格式化为 system prompt 的「研究记忆」段（无记忆时返回空串）。
pub fn format_memory_section(entries: &[MemoryEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\n\n【研究记忆】（本会话之前轮次已查证的资料与来源定位，可据此快速定位；\
         需要精确引用时，用 search_papers / read_section 快速取回原文，不要重复全库检索。\
         这些条目不带编号，不得当作当前轮的 [n] 引用）：\n",
    );
    for e in entries {
        out.push_str(&format!("- {}\n", e.text));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ToolStep;
    use crate::ai::llm::{AgentMsg, ChatResponse, ToolDef};
    use serde_json::json;

    fn citation(paper: &str, section: &str, page: Option<i64>, snippet: &str) -> Citation {
        Citation {
            index: 1,
            chunk_id: -1,
            paper_id: paper.to_string(),
            paper_title: paper.to_string(),
            section: section.to_string(),
            page_idx: page,
            snippet: snippet.to_string(),
        }
    }

    #[test]
    fn build_memory_entry_dedupes_and_caps() {
        let cites = vec![
            citation("论文A", "Method", Some(2), "方法细节"),
            citation("论文A", "Method", Some(2), "重复条目应去重"),
            citation("论文B", "Intro", None, "引言内容"),
        ];
        let trace = vec![
            ToolStep {
                name: "web_search".into(),
                args: json!({ "query": "x" }),
                summary: "3 条来源：https://a.com, https://b.com".into(),
                error: None,
            },
            ToolStep {
                name: "get_outline".into(),
                args: json!({}),
                summary: "5 个章节".into(),
                error: None,
            },
        ];
        let entry = build_memory_entry("这篇论文方法如何", &cites, &trace);
        assert!(entry.contains("论文A"));
        assert!(entry.contains("第 3 页")); // page_idx 2 → 第 3 页
        assert!(entry.contains("联网：3 条来源"));
        // 去重：Method 只出现一次
        assert_eq!(entry.matches("论文A").count(), 1);
        // 非网络工具不入条目
        assert!(!entry.contains("get_outline"));
        // 前缀问题
        assert!(entry.contains("问题：这篇论文方法如何"));
    }

    #[test]
    fn build_memory_entry_empty_without_sources() {
        let entry = build_memory_entry("问题", &[], &[]);
        assert!(entry.is_empty());
    }

    /// 脚本化 LLM：chat_with_tools 返回预设文本或错误。
    struct Scripted {
        reply: Option<String>,
    }
    impl LlmChat for Scripted {
        async fn chat_with_tools(
            &self,
            _m: &[AgentMsg],
            _t: &[ToolDef],
        ) -> Result<ChatResponse> {
            match &self.reply {
                Some(t) => Ok(ChatResponse {
                    content: Some(t.clone()),
                    reasoning: None,
                    tool_calls: vec![],
                }),
                None => anyhow::bail!("LLM 失败"),
            }
        }
    }

    #[tokio::test]
    async fn append_memory_under_cap_keeps_entries() {
        let llm = Scripted { reply: None };
        let entries = vec![MemoryEntry {
            text: "论文《A》· 第 3 页 · Method：…".into(),
            at: 1,
        }];
        let out = append_memory(&llm, entries, "论文《B》· Intro：…".into(), 2).await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].text, "论文《B》· Intro：…");
    }

    #[tokio::test]
    async fn append_memory_compresses_when_over_cap() {
        let llm = Scripted {
            reply: Some("合并后的精炼记忆".into()),
        };
        // 条目数超限（> MEMORY_MAX_ENTRIES）→ 触发 LLM 压缩
        let mut entries = Vec::new();
        for i in 0..(MEMORY_MAX_ENTRIES + 2) {
            entries.push(MemoryEntry {
                text: format!("论文《P{i}》· 第 1 页：内容"),
                at: i as i64,
            });
        }
        let out = append_memory(&llm, entries, "新条目".into(), 99).await;
        assert_eq!(out.len(), 1);
        assert!(out[0].text.contains("合并后的精炼记忆"));
        assert_eq!(out[0].at, 99);
    }

    #[tokio::test]
    async fn append_memory_llm_failure_drops_oldest() {
        let llm = Scripted { reply: None }; // 压缩失败
        let mut entries = Vec::new();
        for i in 0..(MEMORY_MAX_ENTRIES + 2) {
            entries.push(MemoryEntry {
                text: format!("条目{i}"),
                at: i as i64,
            });
        }
        let out = append_memory(&llm, entries, "新条目".into(), 99).await;
        // 丢弃最旧，保留最新 MEMORY_MAX_ENTRIES 条（9 条 → 删 3 条最旧）
        assert_eq!(out.len(), MEMORY_MAX_ENTRIES);
        assert_eq!(out[0].at, 3);
        assert_eq!(out[out.len() - 1].at, 99);
    }

    #[test]
    fn format_memory_section_empty_and_with() {
        assert!(format_memory_section(&[]).is_empty());
        let entries = vec![MemoryEntry {
            text: "论文《A》· 第 3 页 · Method：…".into(),
            at: 1,
        }];
        let s = format_memory_section(&entries);
        assert!(s.contains("研究记忆"));
        assert!(s.contains("论文《A》"));
        assert!(s.contains("不带编号"));
    }
}
