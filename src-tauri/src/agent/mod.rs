//! agent 深度研究循环：调模型 → 执行工具 → 结果回喂 → 重复（借鉴 DSH `dsh-agent-loop`）。
//!
//! 一次 `run_agent` 对应一轮问答：system + 历史 + 当前问题入消息列表，循环最多
//! `MAX_STEPS` 次调用带工具的 LLM：
//! - 模型返回纯文本 → 结束，取该文本为最终回答；
//! - 模型返回工具调用 → 按序执行（本地工具同步短锁、联网工具异步），结果以
//!   `ToolResult` 消息回喂，本地内容引用编号全局累计；
//! - 工具失败 → 错误文本回喂（模型可换工具或如实说明）；
//! - 步数耗尽仍未产出最终文本 → 兜底回答（附已收集的工具结论摘要）。
//!
//! 引用机制：每个返回本地内容的工具结果自带 `[n]` 编号上下文块（编号由调用时的全局
//! offset 决定），system prompt 指示模型最终回答复用这些编号；引用列表按执行顺序累计
//! 返回给前端，现有 CitationBadge / 跳原文逻辑零改动。

use crate::ai::llm::{AgentMsg, ChatMessage, LlmChat, Role, ToolCallRef, ToolDef};
use crate::db::Db;
use crate::qa::{Citation, QaMessage, SelectionInput};
use crate::settings::Settings;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 单轮问答最多模型调用次数（含工具轮次）。
pub const MAX_STEPS: usize = 6;
/// 单轮模型调用中最多执行的工具条数（防御）。
const MAX_TOOLS_PER_TURN: usize = 8;

/// 前端展示的一步工具调用轨迹。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStep {
    pub name: String,
    pub args: Value,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// agent 循环产物：最终回答 + 引用 + 工具轨迹。
#[derive(Debug, Clone)]
pub struct AgentOutcome {
    pub answer: String,
    pub citations: Vec<Citation>,
    pub trace: Vec<ToolStep>,
}

/// 运行一轮深度研究（agent 模式）。
///
/// 注意：本函数不做「模型不支持工具」的降级——由命令层捕获错误后回退到快速问答。
pub async fn run_agent<L: LlmChat>(
    llm: &L,
    db: &Db,
    settings: &Settings,
    question: &str,
    paper_id: Option<&str>,
    history: &[QaMessage],
    selections: &[SelectionInput],
) -> Result<AgentOutcome> {
    let http = reqwest::Client::new();
    let tools = tools::build_tools(settings, paper_id, selections);
    let web_enabled = tools.iter().any(|t| matches!(t, tools::ToolKind::WebSearch));

    let mut messages: Vec<AgentMsg> = Vec::new();
    messages.push(AgentMsg::Plain(ChatMessage {
        role: Role::System,
        content: build_system_prompt(web_enabled, selections.len()),
    }));
    for m in history {
        messages.push(AgentMsg::Plain(ChatMessage {
            role: m.role,
            content: m.content.clone(),
        }));
    }
    messages.push(AgentMsg::Plain(ChatMessage {
        role: Role::User,
        content: question.to_string(),
    }));

    let schemas: Vec<ToolDef> = tools
        .iter()
        .map(|t| ToolDef {
            name: t.name().to_string(),
            description: t.description().to_string(),
            parameters: t.parameters(),
        })
        .collect();

    let mut citations: Vec<Citation> = Vec::new();
    let mut trace: Vec<ToolStep> = Vec::new();
    let mut last_content: Option<String> = None;
    let ctx = tools::ToolCtx {
        db,
        settings,
        http: &http,
        paper_id,
        selections,
    };

    for _ in 0..MAX_STEPS {
        let resp = llm.chat_with_tools(&messages, &schemas).await?;
        if resp.tool_calls.is_empty() {
            if let Some(c) = &resp.content {
                if !c.trim().is_empty() {
                    last_content = Some(c.clone());
                    break;
                }
            }
            // 无文本且无工具调用：罕见情况，跳出兜底
            break;
        }
        if let Some(c) = &resp.content {
            if !c.trim().is_empty() {
                last_content = Some(c.clone());
            }
        }

        // 记录 assistant 工具调用消息，再按序执行并回喂结果
        let calls: Vec<ToolCallRef> = resp.tool_calls;
        messages.push(AgentMsg::ToolCalls {
            content: resp.content.clone(),
            calls: calls.clone(),
        });
        let mut offset = citations.len();
        for call in calls.iter().take(MAX_TOOLS_PER_TURN) {
            let kind = tools
                .iter()
                .find(|t| t.name() == call.name)
                .copied()
                .ok_or_else(|| anyhow::anyhow!("模型调用了未知工具: {}", call.name))?;
            let step = match tools::execute_tool(kind, &ctx, &call.arguments, offset).await {
                Ok(out) => {
                    let n = out.citations.len();
                    citations.extend(out.citations);
                    offset += n;
                    messages.push(AgentMsg::ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        content: out.text,
                    });
                    ToolStep {
                        name: call.name.clone(),
                        args: call.arguments.clone(),
                        summary: out.summary,
                        error: None,
                    }
                }
                Err(e) => {
                    let err_text = crate::qa::truncate(&e, 800);
                    messages.push(AgentMsg::ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        content: format!("工具执行失败：{err_text}"),
                    });
                    ToolStep {
                        name: call.name.clone(),
                        args: call.arguments.clone(),
                        summary: String::new(),
                        error: Some(e),
                    }
                }
            };
            trace.push(step);
        }
    }

    let answer = match last_content {
        Some(c) if !c.trim().is_empty() => c,
        _ => build_fallback_answer(&trace),
    };
    Ok(AgentOutcome {
        answer,
        citations,
        trace,
    })
}

/// 动态 system prompt：base 研读指引 + 引用规则 + 按启用状态拼接的工具指引段。
fn build_system_prompt(web_enabled: bool, selections: usize) -> String {
    let mut p = String::from(
        "你是一名论文研究助手，帮助用户深入理解论文。你可以调用工具从多个角度研读论文：\
         本地知识库语义检索、章节精读、章节目录、论文元数据、用户标注与译文。\n\n\
         工作流程建议：\n\
         1. 先用 get_outline / get_paper_meta 了解论文结构与背景；\n\
         2. 再用 search_papers / read_section 精读与问题相关的章节；\n\
         3. 综合所有资料后给出有依据的回答。\n\n\
         引用规则：\n\
         - 引用本地资料时，必须复用工具结果中给出的编号 [n]；\n\
         - 资料中没有的信息要明确说明「资料中没有相关信息」，不要编造。\n\n\
         要求：用中文回答，简洁准确。",
    );
    if web_enabled {
        p.push_str(
            "\n\n联网搜索：需要外部背景、最新进展或对比资料时，可使用 web_search 发现资料\
             （返回来源列表与摘录），对具体来源可用 web_fetch 获取全文；回答时以 markdown 链接\
             形式引用来源。搜索无结果或报错时，换个说法重试一次，或基于本地知识回答并如实说明。",
        );
    }
    if selections > 0 {
        p.push_str(&format!(
            "\n\n用户选中了 {selections} 段论文原文（阅读页划选），可使用 read_selection 工具读取（index 从 0 开始）。优先围绕选中段落回答。"
        ));
    }
    p
}

/// 兜底回答：步数耗尽且无最终文本时，汇总已执行的工具结论。
fn build_fallback_answer(trace: &[ToolStep]) -> String {
    if trace.is_empty() {
        return "我未能生成有效回答。请换一种问法重试，或切换为「快速问答」模式。".to_string();
    }
    let mut out = String::from(
        "我完成了多轮资料查阅，但未能整理出完整回答。以下是已获取的资料摘要，供你参考：\n",
    );
    for step in trace {
        let err = step
            .error
            .as_deref()
            .map(|e| format!("（失败：{e}）"))
            .unwrap_or_default();
        out.push_str(&format!("- 工具 `{}`：{}{}\n", step.name, step.summary, err));
    }
    out.push_str("\n你可以继续追问，或切换为「快速问答」模式。");
    out
}

pub mod tools;
pub mod web;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::llm::{AgentMsg, ChatResponse, LlmChat, ToolCallRef};
    use crate::db::Db;
    use crate::qa::SelectionInput;
    use rusqlite::Connection;
    use serde_json::json;
    use std::cell::Cell;

    /// 脚本化假 LLM：按调用顺序返回预置响应。
    struct ScriptedLlm {
        responses: Vec<ChatResponse>,
        counter: Cell<usize>,
    }

    impl ScriptedLlm {
        fn new(responses: Vec<ChatResponse>) -> Self {
            Self {
                responses,
                counter: Cell::new(0),
            }
        }
    }

    impl LlmChat for ScriptedLlm {
        async fn chat_with_tools(
            &self,
            _messages: &[AgentMsg],
            _tools: &[ToolDef],
        ) -> Result<ChatResponse> {
            let i = self.counter.get();
            self.counter.set(i + 1);
            Ok(self.responses[i].clone())
        }
    }

    fn content(text: &str) -> ChatResponse {
        ChatResponse {
            content: Some(text.to_string()),
            reasoning: None,
            tool_calls: vec![],
        }
    }

    fn calls(pairs: &[(&str, &str, serde_json::Value)]) -> ChatResponse {
        ChatResponse {
            content: None,
            reasoning: None,
            tool_calls: pairs
                .iter()
                .map(|(id, name, args)| ToolCallRef {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: args.clone(),
                })
                .collect(),
        }
    }

    fn setup() -> (ScriptedLlm, Db, Settings) {
        let db = Db::from_connection(Connection::open_in_memory().unwrap());
        (ScriptedLlm::new(vec![]), db, Settings::default())
    }

    fn sel(text: &str, page: Option<i64>) -> SelectionInput {
        SelectionInput {
            text: text.to_string(),
            page_idx: page,
        }
    }

    #[tokio::test]
    async fn direct_answer_without_tools() {
        let (llm, db, settings) = setup();
        let llm = ScriptedLlm::new(vec![content("直接回答")]);
        let out = run_agent(&llm, &db, &settings, "你好", Some("p1"), &[], &[])
            .await
            .unwrap();
        assert_eq!(out.answer, "直接回答");
        assert!(out.trace.is_empty());
        assert!(out.citations.is_empty());
    }

    #[tokio::test]
    async fn calls_selection_tools_and_numbers_citations_continuously() {
        let (llm, db, settings) = setup();
        let selections = [sel("第一段选中", Some(2)), sel("第二段选中", Some(5))];
        let llm = ScriptedLlm::new(vec![
            // 第一轮：同时请求两个 read_selection（按序执行）
            calls(&[
                ("c1", "read_selection", json!({ "index": 0 })),
                ("c2", "read_selection", json!({ "index": 1 })),
            ]),
            // 第二轮：再读一次（引用编号应从 3 起）
            calls(&[("c3", "read_selection", json!({ "index": 1 }))]),
            // 最终回答复用编号
            content("综合 [1] 与 [3] 得出结论。"),
        ]);
        let out = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &selections)
            .await
            .unwrap();
        assert_eq!(out.answer, "综合 [1] 与 [3] 得出结论。");
        assert_eq!(out.trace.len(), 3);
        // 引用编号全局连续：1,2,3
        let idxs: Vec<usize> = out.citations.iter().map(|c| c.index).collect();
        assert_eq!(idxs, vec![1, 2, 3]);
        // 工具结果消息回喂了全局编号
        assert!(out.citations[0].snippet.contains("第一段选中"));
        assert_eq!(out.citations[0].page_idx, Some(2));
    }

    #[tokio::test]
    async fn tool_error_is_fed_back_and_trace_marks_it() {
        let (llm, db, settings) = setup();
        let llm = ScriptedLlm::new(vec![
            // search_papers 缺 query 参数 → 工具报错
            calls(&[("c1", "search_papers", json!({}))]),
            content("我无法检索，但可以基于已有知识回答。"),
        ]);
        let out = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &[])
            .await
            .unwrap();
        assert_eq!(out.trace.len(), 1);
        assert!(out.trace[0].error.is_some());
        assert!(out.trace[0].name == "search_papers");
        assert_eq!(out.answer, "我无法检索，但可以基于已有知识回答。");
    }

    #[tokio::test]
    async fn unknown_tool_aborts_loop_with_error() {
        let (llm, db, settings) = setup();
        let llm = ScriptedLlm::new(vec![calls(&[("c1", "no_such_tool", json!({}))])]);
        let err = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &[])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("未知工具"));
    }

    #[tokio::test]
    async fn max_steps_exhausted_produces_fallback() {
        let (llm, db, settings) = setup();
        let selections = [sel("选中", None)];
        // 每轮都只调工具，永不给出文本 → 触发 MAX_STEPS 兜底
        let mut responses = Vec::new();
        for i in 0..6 {
            responses.push(calls(&[(
                &format!("c{i}"),
                "read_selection",
                json!({ "index": 0 }),
            )]));
        }
        let llm = ScriptedLlm::new(responses);
        let out = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &selections)
            .await
            .unwrap();
        assert_eq!(out.trace.len(), 6);
        assert!(out.answer.contains("未能整理出完整回答"));
        assert!(out.answer.contains("read_selection"));
    }

    #[test]
    fn system_prompt_web_section_follows_enablement() {
        let with_web = build_system_prompt(true, 0);
        assert!(with_web.contains("web_search"));
        let without = build_system_prompt(false, 0);
        assert!(!without.contains("web_search"));
        assert!(without.contains("引用规则"));
        // 选中段落指引按数量拼接
        let with_sel = build_system_prompt(false, 3);
        assert!(with_sel.contains("read_selection"));
    }
}
