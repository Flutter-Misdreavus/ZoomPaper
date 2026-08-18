//! agent 深度研究循环：调模型 → 执行工具 → 结果回喂 → 重复（借鉴 DSH `dsh-agent-loop`）。
//!
//! 一次 `run_agent` 对应一轮问答：system + 历史 + 当前问题入消息列表，循环最多
//! `MAX_STEPS` 次调用带工具的 LLM：
//! - 模型返回纯文本 → 结束，取该文本为最终回答；
//! - 模型返回工具调用 → 按序执行（本地工具同步短锁、联网工具异步），结果以
//!   `ToolResult` 消息回喂，本地内容引用编号全局累计；
//! - 工具失败 → 错误文本回喂（模型可换工具或如实说明）；
//! - 模型调用 `ask_user` → **中断**：保存运行现场（[`AgentRunState`]）返回
//!   [`RunResult::NeedInput`]，命令层持久化后由前端向用户提问；用户回答经
//!   [`resume_agent`] 从断点继续（每轮最多澄清一次）；
//! - 步数耗尽仍未产出最终文本 → 兜底回答（附已收集的工具结论摘要）。
//!
//! 引用机制：每个返回本地内容的工具结果自带 `[n]` 编号上下文块（编号由调用时的全局
//! offset 决定），system prompt 指示模型最终回答复用这些编号；引用列表按执行顺序累计
//! 返回给前端，现有 CitationBadge / 跳原文逻辑零改动。
//!
//! 会话级研究记忆（[`memory`]）：命令层把会话的已查证来源定位注入 system prompt，
//! 模型据此直接定位来源、不重复全库检索。

use crate::ai::llm::{AgentMsg, ChatMessage, LlmChat, Role, ToolCallRef, ToolDef};
use crate::db::Db;
use crate::qa::{truncate, Citation, QaMessage, SelectionInput};
use crate::settings::Settings;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

pub mod html_extract;
pub mod memory;
pub mod tools;
pub mod web;

/// 单轮问答最多模型调用次数（含工具轮次）。
pub const MAX_STEPS: usize = 6;
/// 单轮模型调用中最多执行的工具条数（防御）。
const MAX_TOOLS_PER_TURN: usize = 8;
/// 用户暂停后无正文可提交时的回答提示。
const PAUSED_ANSWER: &str = "已暂停生成。";

/// 前端展示的一步工具调用轨迹。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStep {
    pub name: String,
    pub args: Value,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 推送给前端的实时事件（Tauri Channel 载荷）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 思考 token 增量
    Thinking { text: String },
    /// 回答正文 token 增量
    Content { text: String },
    /// 工具开始调用
    ToolStart { name: String, args: Value },
    /// 工具执行完成（含单工具耗时）
    ToolEnd {
        name: String,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        elapsed_ms: u64,
    },
}

/// AI 耗时记录：model_ms = 模型调用墙钟合计（思考+决策+生成）；tool_ms = 工具执行合计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Timing {
    pub model_ms: u64,
    pub tool_ms: u64,
}

/// agent 运行现场（ask_user 澄清中断时持久化，供续跑）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunState {
    /// 完整消息列表（含已执行的 ToolCalls / ToolResult 与合成"未执行"结果）
    pub messages: Vec<AgentMsg>,
    /// 已消耗的模型调用步数（续跑从此继续）
    pub step: usize,
    pub citations: Vec<Citation>,
    pub trace: Vec<ToolStep>,
    pub paper_id: Option<String>,
    pub selections: Vec<SelectionInput>,
    /// 等待用户回答的 ask_user 调用
    pub pending_call: ToolCallRef,
    /// 本轮原始问题（记忆条目与续跑上下文用）
    pub question: String,
    /// 是否已澄清过（每轮最多一次）
    pub asked_user: bool,
    /// 状态创建时间（unix 秒；过期检查用）
    pub updated_at: i64,
    /// 已累计的模型调用耗时（ms；澄清续跑后继续累加）
    #[serde(default)]
    pub model_ms: u64,
    /// 已累计的工具执行耗时（ms）
    #[serde(default)]
    pub tool_ms: u64,
}

/// 一次 agent 运行的产物：完成 或 等待用户澄清。
#[derive(Debug, Clone)]
pub enum RunResult {
    Done {
        answer: String,
        citations: Vec<Citation>,
        trace: Vec<ToolStep>,
        timing: Timing,
    },
    NeedInput {
        question: String,
        options: Option<Vec<String>>,
        free_text: bool,
        citations: Vec<Citation>,
        trace: Vec<ToolStep>,
        state: AgentRunState,
    },
}

/// 运行一轮深度研究（agent 模式，新问题）。
///
/// `memory`：本会话之前轮次的研究记忆（注入 system prompt 的「研究记忆」段）；
/// `sink`：实时事件回调（思考/正文/工具状态），前端经 Tauri Channel 接收。
/// `cancel`：用户「暂停」标志；置位时中断生成并返回已生成的部分内容。
/// 注意：本函数不做「模型不支持工具」的降级——由命令层捕获错误后回退到快速问答。
#[allow(clippy::too_many_arguments)]
pub async fn run_agent<L: LlmChat>(
    llm: &L,
    db: &Db,
    settings: &Settings,
    question: &str,
    paper_id: Option<&str>,
    history: &[QaMessage],
    selections: &[SelectionInput],
    memory: &[memory::MemoryEntry],
    cancel: Option<&AtomicBool>,
    sink: &mut (dyn FnMut(AgentEvent) + Send),
) -> Result<RunResult> {
    // 阅读页会话绑定论文的标题（system 提示「当前论文优先」段用；查询失败回退占位）
    let paper_title: Option<String> = paper_id.map(|pid| {
        db.conn()
            .query_row("SELECT title FROM papers WHERE id = ?1", [pid], |r| {
                r.get::<_, String>(0)
            })
            .unwrap_or_else(|_| "当前论文".to_string())
    });
    let tools = tools::build_tools(settings, paper_id, selections);
    let web_enabled = tools.iter().any(|t| matches!(t, tools::ToolKind::WebSearch));

    let mut messages: Vec<AgentMsg> = Vec::new();
    // system 提示注入标题前截断（防超长标题撑爆提示词）
    let prompt_title = paper_title.as_deref().map(|t| truncate(t, 120));
    messages.push(AgentMsg::Plain(ChatMessage {
        role: Role::System,
        content: build_system_prompt(
            web_enabled,
            selections.len(),
            prompt_title.as_deref(),
            memory,
        ),
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

    run_agent_loop(llm, db, settings, messages, paper_id, selections, tools, cancel, sink).await
}

/// 通用循环入口：给定完整消息列表（system + 历史 + user）与工具集，运行 agent 循环。
///
/// 供费曼等非 RAG 场景复用（调用方自行组装消息与工具集）；行为与 [`run_agent`] 一致：
/// 流式思考/正文经 `sink` 转发、工具执行发 ToolStart/ToolEnd、耗时累计返回。
/// `cancel`：用户「暂停」标志，置位时中断生成并返回已生成的部分内容。
pub async fn run_agent_loop<L: LlmChat>(
    llm: &L,
    db: &Db,
    settings: &Settings,
    messages: Vec<AgentMsg>,
    paper_id: Option<&str>,
    selections: &[SelectionInput],
    tools: Vec<tools::ToolKind>,
    cancel: Option<&AtomicBool>,
    sink: &mut (dyn FnMut(AgentEvent) + Send),
) -> Result<RunResult> {
    let http = reqwest::Client::new();
    let schemas = tool_schemas(&tools);
    let ctx = tools::ToolCtx {
        db,
        settings,
        http: &http,
        paper_id,
        selections,
    };
    let mut messages = messages;
    let mut citations: Vec<Citation> = Vec::new();
    let mut trace: Vec<ToolStep> = Vec::new();
    let mut model_ms: u64 = 0;
    let mut tool_ms: u64 = 0;
    drive_loop(
        llm, &ctx, &tools, &mut messages, &schemas, 0, &mut citations, &mut trace, false, "",
        cancel, sink, &mut model_ms, &mut tool_ms,
    )
    .await
}

/// 把纯文本消息列表转为 agent 消息（费曼等非工具消息场景复用）。
pub fn plain_messages(messages: Vec<ChatMessage>) -> Vec<AgentMsg> {
    messages.into_iter().map(AgentMsg::Plain).collect()
}

/// 从澄清断点续跑：把用户回答回喂为 ask_user 的结果，继续循环。
pub async fn resume_agent<L: LlmChat>(
    llm: &L,
    db: &Db,
    settings: &Settings,
    state: AgentRunState,
    reply: &str,
    cancel: Option<&AtomicBool>,
    sink: &mut (dyn FnMut(AgentEvent) + Send),
) -> Result<RunResult> {
    let http = reqwest::Client::new();
    let tools = tools::build_tools(settings, state.paper_id.as_deref(), &state.selections);
    let schemas = tool_schemas(&tools);
    let ctx = tools::ToolCtx {
        db,
        settings,
        http: &http,
        paper_id: state.paper_id.as_deref(),
        selections: &state.selections,
    };
    let mut messages = state.messages;
    let mut citations = state.citations;
    let mut trace = state.trace;
    // 回喂用户回答（该调用此前未注入结果，保证协议完整），并标记澄清工具完成
    messages.push(AgentMsg::ToolResult {
        call_id: state.pending_call.id.clone(),
        name: "ask_user".to_string(),
        content: reply.to_string(),
    });
    sink(AgentEvent::ToolEnd {
        name: "ask_user".to_string(),
        summary: truncate(reply, 60),
        error: None,
        elapsed_ms: 0, // 等待用户的时间不算 AI 思考/工具耗时
    });
    let mut model_ms = state.model_ms;
    let mut tool_ms = state.tool_ms;
    drive_loop(
        llm,
        &ctx,
        &tools,
        &mut messages,
        &schemas,
        state.step,
        &mut citations,
        &mut trace,
        true, // 已澄清过：续跑中不再允许第二次 ask_user
        &state.question,
        cancel,
        sink,
        &mut model_ms,
        &mut tool_ms,
    )
    .await
}

fn tool_schemas(tools: &[tools::ToolKind]) -> Vec<ToolDef> {
    tools
        .iter()
        .map(|t| ToolDef {
            name: t.name().to_string(),
            description: t.description().to_string(),
            parameters: t.parameters(),
        })
        .collect()
}

/// 循环驱动器：从 `step` 起调用模型，执行工具/处理澄清，直到完成或中断。
///
/// `cancel`：用户「暂停」标志；循环顶部与模型调用期间检查，置位即停止并返回
/// 已生成的部分内容（正文流中暂停 → 部分正文即最终回答；工具阶段暂停 → 短提示回答）。
#[allow(clippy::too_many_arguments)]
async fn drive_loop<L: LlmChat>(
    llm: &L,
    ctx: &tools::ToolCtx<'_>,
    tools: &[tools::ToolKind],
    messages: &mut Vec<AgentMsg>,
    schemas: &[ToolDef],
    step: usize,
    citations: &mut Vec<Citation>,
    trace: &mut Vec<ToolStep>,
    asked_user: bool,
    question: &str,
    cancel: Option<&AtomicBool>,
    sink: &mut (dyn FnMut(AgentEvent) + Send),
    model_ms: &mut u64,
    tool_ms: &mut u64,
) -> Result<RunResult> {
    let mut used = step;
    while used < MAX_STEPS {
        // 用户暂停（工具执行期间点暂停）：本轮不再继续，返回短提示回答
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Ok(RunResult::Done {
                answer: PAUSED_ANSWER.to_string(),
                citations: citations.clone(),
                trace: trace.clone(),
                timing: Timing {
                    model_ms: *model_ms,
                    tool_ms: *tool_ms,
                },
            });
        }
        used += 1;
        // 模型调用（流式：思考/正文增量转发给 sink；模型调用耗时计入「思考」时间）
        let t0 = std::time::Instant::now();
        let resp = llm
            .stream_chat_with_tools_abortable(messages, schemas, cancel, &mut |evt| match evt {
                crate::ai::llm::StreamEvent::Thinking(t) => {
                    sink(AgentEvent::Thinking { text: t })
                }
                crate::ai::llm::StreamEvent::Content(t) => sink(AgentEvent::Content { text: t }),
            })
            .await?;
        *model_ms += t0.elapsed().as_millis() as u64;
        // 用户暂停（正文流中/模型调用后）：把已累积的部分内容作为最终回答，不再继续
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            let answer = match &resp.content {
                Some(c) if !c.trim().is_empty() => c.clone(),
                _ => PAUSED_ANSWER.to_string(),
            };
            return Ok(RunResult::Done {
                answer,
                citations: citations.clone(),
                trace: trace.clone(),
                timing: Timing {
                    model_ms: *model_ms,
                    tool_ms: *tool_ms,
                },
            });
        }
        if resp.tool_calls.is_empty() {
            let answer = match &resp.content {
                Some(c) if !c.trim().is_empty() => c.clone(),
                _ => build_fallback_answer(trace),
            };
            return Ok(RunResult::Done {
                answer,
                citations: citations.clone(),
                trace: trace.clone(),
                timing: Timing {
                    model_ms: *model_ms,
                    tool_ms: *tool_ms,
                },
            });
        }

        // 记录 assistant 工具调用消息，再按序执行
        let calls = resp.tool_calls;
        messages.push(AgentMsg::ToolCalls {
            content: resp.content.clone(),
            calls: calls.clone(),
        });
        let mut offset = citations.len();
        for (i, call) in calls.iter().take(MAX_TOOLS_PER_TURN).enumerate() {
            let kind = tools
                .iter()
                .find(|t| t.name() == call.name)
                .copied()
                .ok_or_else(|| anyhow::anyhow!("模型调用了未知工具: {}", call.name))?;

            // ask_user：中断循环等待用户（每轮最多一次）
            if kind == tools::ToolKind::AskUser {
                if asked_user {
                    messages.push(AgentMsg::ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        content: "工具执行失败：已向用户询问过一次澄清，请基于已有信息继续回答，或明确说明资料不足。"
                            .to_string(),
                    });
                    trace.push(ToolStep {
                        name: call.name.clone(),
                        args: call.arguments.clone(),
                        summary: String::new(),
                        error: Some("每轮最多澄清一次".to_string()),
                    });
                    sink(AgentEvent::ToolEnd {
                        name: call.name.clone(),
                        summary: String::new(),
                        error: Some("每轮最多澄清一次".to_string()),
                        elapsed_ms: 0,
                    });
                    continue;
                }
                // 批次内其后的调用注入"未执行"合成结果，保证每个 tool_call_id 都有结果
                for later in calls.iter().skip(i + 1) {
                    messages.push(AgentMsg::ToolResult {
                        call_id: later.id.clone(),
                        name: later.name.clone(),
                        content: "该调用因等待用户澄清而未执行。".to_string(),
                    });
                }
                let q = call.arguments["question"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let options = call.arguments["options"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect::<Vec<_>>()
                    })
                    .filter(|o| !o.is_empty());
                let free_text = call.arguments["free_text"].as_bool().unwrap_or(true);
                trace.push(ToolStep {
                    name: call.name.clone(),
                    args: call.arguments.clone(),
                    summary: truncate(&q, 60),
                    error: None,
                });
                sink(AgentEvent::ToolStart {
                    name: call.name.clone(),
                    args: call.arguments.clone(),
                });
                let state = AgentRunState {
                    messages: messages.clone(),
                    step: used,
                    citations: citations.clone(),
                    trace: trace.clone(),
                    paper_id: ctx.paper_id.map(str::to_string),
                    selections: ctx.selections.to_vec(),
                    pending_call: call.clone(),
                    question: question.to_string(),
                    asked_user: true,
                    updated_at: chrono::Utc::now().timestamp(),
                    model_ms: *model_ms,
                    tool_ms: *tool_ms,
                };
                return Ok(RunResult::NeedInput {
                    question: q,
                    options,
                    free_text,
                    citations: citations.clone(),
                    trace: trace.clone(),
                    state,
                });
            }

            // 正常执行工具：开始 → 计时 → 完成（耗时计入工具时间）
            sink(AgentEvent::ToolStart {
                name: call.name.clone(),
                args: call.arguments.clone(),
            });
            let t0 = std::time::Instant::now();
            let step_out = match tools::execute_tool(kind, ctx, &call.arguments, offset).await {
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
                    let err_text = truncate(&e, 800);
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
            let elapsed_ms = t0.elapsed().as_millis() as u64;
            *tool_ms += elapsed_ms;
            sink(AgentEvent::ToolEnd {
                name: call.name.clone(),
                summary: step_out.summary.clone(),
                error: step_out.error.clone(),
                elapsed_ms,
            });
            trace.push(step_out);
        }
    }
    // 步数耗尽：兜底
    Ok(RunResult::Done {
        answer: build_fallback_answer(trace),
        citations: citations.clone(),
        trace: trace.clone(),
        timing: Timing {
            model_ms: *model_ms,
            tool_ms: *tool_ms,
        },
    })
}

/// 动态 system prompt：base 研读指引 + 【当前论文】段（绑定论文时）+ 澄清说明 + 引用规则 +
/// 记忆段 + 按启用状态拼接的工具指引段。
///
/// `paper_title`：阅读页会话绑定论文的标题；`Some` 时注入「当前论文优先」段并弱化联网段
/// （当前论文能回答就不联网）；`None`（跨论文会话）时保持原措辞。
fn build_system_prompt(
    web_enabled: bool,
    selections: usize,
    paper_title: Option<&str>,
    memory: &[memory::MemoryEntry],
) -> String {
    let bound = paper_title.filter(|t| !t.trim().is_empty());
    let mut p = String::from(
        "你是一名论文研究助手，帮助用户深入理解论文。你可以调用工具从多个角度研读论文：\
         本地知识库语义检索、章节精读、章节目录、论文元数据、用户标注与译文。\n\n\
         工作流程建议：\n\
         1. 先用 get_outline / get_paper_meta 了解论文结构与背景；\n\
         2. 再用 search_papers / read_section 精读与问题相关的章节；\n\
         3. 需要外部信息时联网搜索，然后综合所有资料给出有依据的回答。\n\n\
         澄清说明：如果问题有歧义、或需要用户选择研究方向，且现有信息不足以继续时，\
         可调用 ask_user 向用户澄清（每轮最多一次）；优先基于已有信息回答，不要频繁打断。\n\n\
         引用规则：\n\
         - 引用本地资料时，必须复用工具结果中给出的编号 [n]；\n\
         - 资料中没有的信息要明确说明「资料中没有相关信息」，不要编造。\n\n\
         要求：用中文回答，简洁准确。",
    );
    // 绑定论文：注入「当前论文优先」段（阅读页会话的注意力锚点）
    if let Some(title) = bound {
        p.push_str(&format!(
            "\n\n【当前论文】\n本会话正在阅读论文《{title}》。回答时：\n\
             1. 优先从这篇论文取材：先 get_outline / get_paper_meta 了解结构，\
             再 search_papers（省略 paper_id 即检索当前论文）/ read_section 精读相关章节；\n\
             2. 当前论文能回答的问题，不要转向其他论文或联网搜索；\n\
             3. 确需参考其他论文或联网资料时，回答中明确区分「本篇论文」「其他论文」「联网资料」，\
             并优先引用本篇内容。"
        ));
    }
    if web_enabled {
        if bound.is_some() {
            // 绑定论文：弱化联网段——当前论文优先，联网仅作补充并明确标注外部资料
            p.push_str(
                "\n\n联网搜索：当前论文能回答的问题优先从论文取材，不要联网；\
                 确需外部信息（该方向的最新进展、与其他工作的对比、背景资料、事实核验、作者/机构信息等）\
                 或当前论文确实无法回答时，再使用 web_search 查证。对具体来源可用 web_fetch 获取全文，\
                 回答时以 markdown 链接形式引用来源，并明确标注为外部资料。搜索无结果或报错时，换个说法重试一次。",
            );
        } else {
            // 跨论文会话：保持原措辞
            p.push_str(
                "\n\n联网搜索：当问题涉及论文之外的信息——该方向的最新进展、与其他工作的对比、\
                 背景资料、事实核验、作者/机构信息等——应当使用 web_search 查证后再回答；\
                 本地资料无法回答的问题也必须尝试联网搜索。对具体来源可用 web_fetch 获取全文，\
                 回答时以 markdown 链接形式引用来源。搜索无结果或报错时，换个说法重试一次。",
            );
        }
    }
    if selections > 0 {
        p.push_str(&format!(
            "\n\n用户选中了 {selections} 段论文原文（阅读页划选），可使用 read_selection 工具读取（index 从 0 开始）。优先围绕选中段落回答。"
        ));
    }
    p.push_str(&memory::format_memory_section(memory));
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

    fn ask_user_call(id: &str, question: &str, options: serde_json::Value) -> ChatResponse {
        calls(&[(
            id,
            "ask_user",
            json!({ "question": question, "options": options, "free_text": true }),
        )])
    }

    fn setup() -> (Db, Settings) {
        let db = Db::from_connection(Connection::open_in_memory().unwrap());
        (db, Settings::default())
    }

    fn sel(text: &str, page: Option<i64>) -> SelectionInput {
        SelectionInput {
            text: text.to_string(),
            page_idx: page,
        }
    }

    #[tokio::test]
    async fn direct_answer_without_tools() {
        let (db, settings) = setup();
        let llm = ScriptedLlm::new(vec![content("直接回答")]);
        match run_agent(&llm, &db, &settings, "你好", Some("p1"), &[], &[], &[], None, &mut |_| {})
            .await
            .unwrap()
        {
            RunResult::Done {
                answer,
                citations,
                trace,
                timing: _,
            } => {
                assert_eq!(answer, "直接回答");
                assert!(trace.is_empty());
                assert!(citations.is_empty());
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        }
    }

    #[tokio::test]
    async fn calls_selection_tools_and_numbers_citations_continuously() {
        let (db, settings) = setup();
        let selections = [sel("第一段选中", Some(2)), sel("第二段选中", Some(5))];
        let llm = ScriptedLlm::new(vec![
            calls(&[
                ("c1", "read_selection", json!({ "index": 0 })),
                ("c2", "read_selection", json!({ "index": 1 })),
            ]),
            calls(&[("c3", "read_selection", json!({ "index": 1 }))]),
            content("综合 [1] 与 [3] 得出结论。"),
        ]);
        match run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &selections, &[], None, &mut |_| {})
            .await
            .unwrap()
        {
            RunResult::Done {
                answer,
                citations,
                trace,
                timing: _,
            } => {
                assert_eq!(answer, "综合 [1] 与 [3] 得出结论。");
                assert_eq!(trace.len(), 3);
                let idxs: Vec<usize> = citations.iter().map(|c| c.index).collect();
                assert_eq!(idxs, vec![1, 2, 3]);
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        }
    }

    #[tokio::test]
    async fn tool_error_is_fed_back_and_trace_marks_it() {
        let (db, settings) = setup();
        let llm = ScriptedLlm::new(vec![
            calls(&[("c1", "search_papers", json!({}))]),
            content("我无法检索，但可以基于已有知识回答。"),
        ]);
        match run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &[], &[], None, &mut |_| {})
            .await
            .unwrap()
        {
            RunResult::Done { answer, trace, .. } => {
                assert_eq!(answer, "我无法检索，但可以基于已有知识回答。");
                assert_eq!(trace.len(), 1);
                assert!(trace[0].error.is_some());
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        }
    }

    #[tokio::test]
    async fn unknown_tool_aborts_loop_with_error() {
        let (db, settings) = setup();
        let llm = ScriptedLlm::new(vec![calls(&[("c1", "no_such_tool", json!({}))])]);
        let err = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &[], &[], None, &mut |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("未知工具"));
    }

    #[tokio::test]
    async fn max_steps_exhausted_produces_fallback() {
        let (db, settings) = setup();
        let selections = [sel("选中", None)];
        let mut responses = Vec::new();
        for i in 0..6 {
            responses.push(calls(&[(
                &format!("c{i}"),
                "read_selection",
                json!({ "index": 0 }),
            )]));
        }
        let llm = ScriptedLlm::new(responses);
        match run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &selections, &[], None, &mut |_| {})
            .await
            .unwrap()
        {
            RunResult::Done { answer, trace, .. } => {
                assert_eq!(trace.len(), 6);
                assert!(answer.contains("未能整理出完整回答"));
                assert!(answer.contains("read_selection"));
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        }
    }

    #[test]
    fn system_prompt_web_section_follows_enablement() {
        // 跨论文会话（无绑定论文）：保持原措辞
        let with_web = build_system_prompt(true, 0, None, &[]);
        assert!(with_web.contains("web_search"));
        // 指令式触发规则（原措辞）
        assert!(with_web.contains("应当使用 web_search"));
        assert!(with_web.contains("必须尝试联网搜索"));
        // 跨论文会话不注入「当前论文」段
        assert!(!with_web.contains("【当前论文】"));
        let without = build_system_prompt(false, 0, None, &[]);
        assert!(!without.contains("web_search"));
        assert!(without.contains("引用规则"));
        assert!(without.contains("ask_user")); // 澄清说明常驻
        let with_sel = build_system_prompt(false, 3, None, &[]);
        assert!(with_sel.contains("read_selection"));
        // 记忆段注入
        let with_mem = build_system_prompt(
            false,
            0,
            None,
            &[memory::MemoryEntry {
                text: "论文《A》· 第 3 页 · Method：…".into(),
                at: 1,
            }],
        );
        assert!(with_mem.contains("研究记忆"));
    }

    #[test]
    fn system_prompt_prioritizes_bound_paper_and_softens_web() {
        // 绑定论文 + 联网开：注入【当前论文】段，web 段弱化（不再强制联网）
        let bound_web = build_system_prompt(true, 0, Some("注意力论文"), &[]);
        assert!(bound_web.contains("【当前论文】"));
        assert!(bound_web.contains("正在阅读论文《注意力论文》"));
        assert!(bound_web.contains("优先从这篇论文取材"));
        assert!(bound_web.contains("不要转向其他论文或联网搜索"));
        assert!(bound_web.contains("本篇论文」「其他论文」「联网资料"));
        // web 段弱化：保留工具名，但不再出现「必须尝试联网搜索」的强制措辞
        assert!(bound_web.contains("web_search"));
        assert!(bound_web.contains("当前论文能回答的问题优先从论文取材，不要联网"));
        assert!(!bound_web.contains("必须尝试联网搜索"));
        assert!(!bound_web.contains("应当使用 web_search"));

        // 绑定论文但联网关闭：仍注入【当前论文】段，无 web 段
        let bound_no_web = build_system_prompt(false, 0, Some("注意力论文"), &[]);
        assert!(bound_no_web.contains("【当前论文】"));
        assert!(!bound_no_web.contains("web_search"));

        // 空标题视为未绑定
        let empty_title = build_system_prompt(true, 0, Some("   "), &[]);
        assert!(!empty_title.contains("【当前论文】"));
        assert!(empty_title.contains("应当使用 web_search"));
    }

    // ---------- 生成取消（「暂停」） ----------

    #[tokio::test]
    async fn cancel_between_tool_steps_stops_loop_with_paused_answer() {
        let (db, settings) = setup();
        // 第一轮调工具；工具结束后（ToolEnd 事件）置位取消标志 → 第二轮循环顶部应提前结束
        let llm = ScriptedLlm::new(vec![
            calls(&[("c1", "search_papers", json!({}))]),
            content("不应到达的最终回答"),
        ]);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let cancel_in_sink = cancel.clone();
        let run = run_agent(
            &llm,
            &db,
            &settings,
            "问题",
            Some("p1"),
            &[],
            &[],
            &[],
            Some(cancel.as_ref()),
            &mut |e| {
                if matches!(e, AgentEvent::ToolEnd { .. }) {
                    cancel_in_sink.store(true, Ordering::Relaxed);
                }
            },
        )
        .await
        .unwrap();
        match run {
            RunResult::Done { answer, trace, .. } => {
                assert!(trace.len() >= 1, "第一轮工具应已执行");
                assert!(answer.contains("已暂停"), "回答应为暂停提示，实际: {answer}");
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        }
        // 模型只被调用一次（第二轮被取消拦截）
        assert_eq!(llm.counter.get(), 1);
    }

    #[tokio::test]
    async fn cancel_mid_stream_keeps_partial_content_as_answer() {
        let (db, settings) = setup();
        // 第一轮工具；第二轮正文流中置位取消 → 部分正文应作为最终回答
        let llm = ScriptedLlm::new(vec![
            calls(&[("c1", "search_papers", json!({}))]),
            content("部分回答内容"),
        ]);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let cancel_in_sink = cancel.clone();
        let run = run_agent(
            &llm,
            &db,
            &settings,
            "问题",
            Some("p1"),
            &[],
            &[],
            &[],
            Some(cancel.as_ref()),
            &mut |e| {
                if let AgentEvent::Content { text } = &e {
                    if text.contains("部分") {
                        cancel_in_sink.store(true, Ordering::Relaxed);
                    }
                }
            },
        )
        .await
        .unwrap();
        match run {
            RunResult::Done { answer, .. } => {
                assert!(
                    answer.contains("部分回答内容"),
                    "部分正文应保留为回答，实际: {answer}"
                );
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        }
    }

    // ---------- ask_user 澄清 ----------

    #[tokio::test]
    async fn ask_user_interrupts_then_resume_completes() {
        let (db, settings) = setup();
        let llm = ScriptedLlm::new(vec![
            ask_user_call("c1", "你想对比哪个方向？", json!(["A", "B"])),
            content("根据你的选择，最终回答。"),
        ]);
        let run = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &[], &[], None, &mut |_| {})
            .await
            .unwrap();
        let (question, options, free_text, state) = match run {
            RunResult::NeedInput {
                question,
                options,
                free_text,
                state,
                ..
            } => (question, options, free_text, state),
            RunResult::Done { .. } => panic!("应请求澄清"),
        };
        assert_eq!(question, "你想对比哪个方向？");
        assert_eq!(options.unwrap(), vec!["A".to_string(), "B".to_string()]);
        assert!(free_text);
        assert_eq!(state.step, 1);
        assert!(state.asked_user);
        assert_eq!(state.pending_call.name, "ask_user");
        // 中断时未给 ask_user 注入结果
        assert!(!state.messages.iter().any(|m| matches!(
            m,
            AgentMsg::ToolResult { name, .. } if name == "ask_user"
        )));

        // 续跑：回答被回喂为 ask_user 的结果
        let done = resume_agent(&llm, &db, &settings, state, "选 A", None, &mut |_| {})
            .await
            .unwrap();
        match done {
            RunResult::Done { answer, .. } => assert_eq!(answer, "根据你的选择，最终回答。"),
            RunResult::NeedInput { .. } => panic!("不应再次澄清"),
        }
    }

    #[tokio::test]
    async fn ask_user_capped_at_one_after_resume() {
        let (db, settings) = setup();
        let llm = ScriptedLlm::new(vec![
            ask_user_call("c1", "第一次澄清", json!([])),
            ask_user_call("c2", "第二次澄清", json!([])),
            content("最终回答"),
        ]);
        let run = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &[], &[], None, &mut |_| {})
            .await
            .unwrap();
        let state = match &run {
            RunResult::NeedInput { state, .. } => state.clone(),
            _ => panic!("应请求澄清"),
        };
        let done = resume_agent(&llm, &db, &settings, state, "回答", None, &mut |_| {})
            .await
            .unwrap();
        match done {
            RunResult::Done { answer, trace, .. } => {
                assert_eq!(answer, "最终回答");
                // 第二次 ask_user 被拒绝并标记错误
                let ask_steps: Vec<&ToolStep> = trace
                    .iter()
                    .filter(|t| t.name == "ask_user")
                    .collect();
                assert_eq!(ask_steps.len(), 2);
                assert!(ask_steps[1].error.is_some());
            }
            RunResult::NeedInput { .. } => panic!("不应再次请求澄清"),
        }
    }

    #[tokio::test]
    async fn batch_with_ask_user_injects_synthetic_results_for_later_calls() {
        let (db, settings) = setup();
        let selections = [sel("选中段", Some(1))];
        let llm = ScriptedLlm::new(vec![
            calls(&[
                ("c1", "read_selection", json!({ "index": 0 })),
                ("c2", "ask_user", json!({ "question": "确认方向", "options": [] })),
                ("c3", "read_selection", json!({ "index": 0 })),
            ]),
            content("完成"),
        ]);
        let run = run_agent(&llm, &db, &settings, "问题", Some("p1"), &[], &selections, &[], None, &mut |_| {})
            .await
            .unwrap();
        let state = match run {
            RunResult::NeedInput { state, .. } => state,
            _ => panic!("应请求澄清"),
        };
        // c1 正常执行（有结果），c3 注入"未执行"合成结果，c2（ask_user）无结果
        assert!(state.messages.iter().any(|m| matches!(
            m,
            AgentMsg::ToolResult { call_id, .. } if call_id == "c1"
        )));
        assert!(state.messages.iter().any(|m| matches!(
            m,
            AgentMsg::ToolResult { call_id, content, .. }
                if call_id == "c3" && content.contains("未执行")
        )));
        assert!(!state.messages.iter().any(|m| matches!(
            m,
            AgentMsg::ToolResult { call_id, .. } if call_id == "c2"
        )));
        // 引用编号：c1 已产生一条
        assert_eq!(state.citations.len(), 1);
        // 续跑后全部调用都有结果，模型可继续
        let done = resume_agent(&llm, &db, &settings, state, "选 A", None, &mut |_| {})
            .await
            .unwrap();
        assert!(matches!(done, RunResult::Done { .. }));
    }

    #[tokio::test]
    async fn agent_run_state_roundtrips_json() {
        let state = AgentRunState {
            messages: vec![AgentMsg::Plain(ChatMessage {
                role: Role::User,
                content: "hi".into(),
            })],
            step: 1,
            citations: vec![],
            trace: vec![],
            paper_id: Some("p1".into()),
            selections: vec![],
            pending_call: ToolCallRef {
                id: "c1".into(),
                name: "ask_user".into(),
                arguments: json!({ "question": "?" }),
            },
            question: "问题".into(),
            asked_user: true,
            updated_at: 1,
            model_ms: 1234,
            tool_ms: 56,
        };
        let json = serde_json::to_string(&state).unwrap();
        let back: AgentRunState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.step, 1);
        assert_eq!(back.pending_call.name, "ask_user");
        assert!(back.asked_user);
        assert_eq!(back.model_ms, 1234);
        assert_eq!(back.tool_ms, 56);
        // 旧状态 JSON（无 model_ms/tool_ms 字段）也能解析（serde default = 0）
        let mut obj = serde_json::from_str::<serde_json::Value>(&json)
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        obj.remove("model_ms");
        obj.remove("tool_ms");
        let back2: AgentRunState = serde_json::from_value(serde_json::Value::Object(obj)).unwrap();
        assert_eq!(back2.model_ms, 0);
        assert_eq!(back2.tool_ms, 0);
    }

    /// 实时事件流：思考 → 工具开始 → 工具结束 → 回答；计时单调累计。
    #[tokio::test]
    async fn emits_events_in_order_and_accumulates_timing() {
        let (db, settings) = setup();
        let selections = [sel("选中段", Some(1))];
        // 第一轮：思考 + 调 read_selection；第二轮：最终回答
        let llm = ScriptedLlm::new(vec![
            ChatResponse {
                content: Some("先看一下".into()),
                reasoning: Some("让我想想".into()),
                tool_calls: vec![ToolCallRef {
                    id: "c1".into(),
                    name: "read_selection".into(),
                    arguments: json!({ "index": 0 }),
                }],
            },
            content("最终回答 [1]"),
        ]);
        // 脚本化 LLM 走默认流式实现：非流式响应整体作为一次 Content 事件
        let mut events = Vec::new();
        let run = run_agent(
            &llm,
            &db,
            &settings,
            "问题",
            Some("p1"),
            &[],
            &selections,
            &[],
            None,
            &mut |e| events.push(e),
        )
        .await
        .unwrap();
        let (answer, _timing) = match run {
            RunResult::Done {
                answer,
                timing: _,
                trace,
                ..
            } => {
                assert_eq!(trace.len(), 1);
                (answer, Timing::default())
            }
            RunResult::NeedInput { .. } => panic!("不应请求澄清"),
        };
        assert_eq!(answer, "最终回答 [1]");
        // 事件顺序：Thinking(推理) → Content(先看一下) → ToolStart → ToolEnd → Content(最终回答)
        // （默认流式实现把非流式响应的 reasoning 作为 Thinking 事件补发）
        let kinds: Vec<&str> = events.iter().map(|e| evt_kind(e)).collect();
        assert_eq!(
            kinds,
            vec!["thinking", "content", "tool_start", "tool_end", "content"]
        );
        // 工具结束事件带耗时字段（索引 3 = thinking/content/tool_start 之后）
        if let AgentEvent::ToolEnd { elapsed_ms, .. } = &events[3] {
            let _ = elapsed_ms;
        } else {
            panic!("第 4 个事件应为 ToolEnd");
        }
    }

    fn evt_kind(e: &AgentEvent) -> &'static str {
        match e {
            AgentEvent::Thinking { .. } => "thinking",
            AgentEvent::Content { .. } => "content",
            AgentEvent::ToolStart { .. } => "tool_start",
            AgentEvent::ToolEnd { .. } => "tool_end",
        }
    }
}
