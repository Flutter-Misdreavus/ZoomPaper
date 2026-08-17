//! 统一 LLM 对话接口（多 Provider）。
//!
//! 通过 [`Llm`] 枚举分发到两类请求格式：
//! - **OpenAI 兼容**（openai / deepseek / gemini 共用 `chat/completions`，仅 base URL 与鉴权不同）
//! - **Anthropic**（独立 Messages API，system 单独放顶层字段）
//!
//! 具体 provider 与 API Key 由 [`crate::settings::Settings`] 决定（设置页填写）。

use crate::settings::Settings;
use anyhow::{Context, Result};
use futures_util::StreamExt;
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

// ---------- 工具调用（agent 循环的 wire 层） ----------
//
// 约定：本模块只负责「面向模型的格式」——OpenAI 兼容的 `tools`/`tool_calls`/`role=tool`
// 与 Anthropic 的 `tools`/`tool_use`/`tool_result` 互相映射。agent 循环用 [`AgentMsg`]
// 统一记录消息（含工具调用轮次），测试可用假 [`LlmChat`] 实现注入。

/// 工具定义（面向模型的 JSON Schema）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema（`type: object` + properties/required 等基础字段）。
    pub parameters: serde_json::Value,
}

/// 模型发起的一次工具调用引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRef {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// agent 循环中的一条消息（wire 层，可承载工具调用格式）。
/// 可序列化：agent 运行现场（AgentRunState）需持久化到 conversations.agent_state。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentMsg {
    /// 普通 system / user / assistant 文本消息。
    Plain(ChatMessage),
    /// assistant 发起的一组工具调用（可无文本，仅调用）。
    ToolCalls {
        content: Option<String>,
        calls: Vec<ToolCallRef>,
    },
    /// 工具执行结果（回喂给模型）。
    ToolResult {
        call_id: String,
        /// 工具名（记录用；wire 层按 call_id 匹配即可）
        #[allow(dead_code)]
        name: String,
        content: String,
    },
}

/// `chat_with_tools` 的响应：文本与/或工具调用。
#[derive(Debug, Clone)]
pub struct ChatResponse {
    /// 文本回复（纯工具调用轮次为 None）。
    pub content: Option<String>,
    /// 思考内容（DeepSeek `reasoning_content` / OpenAI `reasoning` / Anthropic `thinking`）。
    /// 预留：后续可展示给用户；当前循环不消费。
    #[allow(dead_code)]
    pub reasoning: Option<String>,
    /// 本轮发起的工具调用（无则为空）。
    pub tool_calls: Vec<ToolCallRef>,
}

/// 流式事件：模型生成过程中的 token 增量。
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// 推理/思考 token（DeepSeek reasoning_content / Anthropic thinking / OpenAI reasoning）
    Thinking(String),
    /// 回答正文 token
    Content(String),
}

/// 工具调用对话能力：agent 循环依赖此抽象，测试可注入脚本化假实现。
pub trait LlmChat {
    async fn chat_with_tools(
        &self,
        messages: &[AgentMsg],
        tools: &[ToolDef],
    ) -> Result<ChatResponse>;

    /// 流式版：`on_event` 收到思考/正文增量，返回完整 [`ChatResponse`]。
    /// 默认实现 = 非流式调用后整体发一次 Thinking（若有 reasoning）与 Content
    /// （供测试假实现、失败回退、以及费曼等非流式场景复用）。
    async fn stream_chat_with_tools(
        &self,
        messages: &[AgentMsg],
        tools: &[ToolDef],
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<ChatResponse> {
        let resp = self.chat_with_tools(messages, tools).await?;
        if let Some(r) = &resp.reasoning {
            if !r.is_empty() {
                on_event(StreamEvent::Thinking(r.clone()));
            }
        }
        if let Some(c) = &resp.content {
            if !c.is_empty() {
                on_event(StreamEvent::Content(c.clone()));
            }
        }
        Ok(resp)
    }
}

/// 无工具调用的流式对话（快速问答用）：返回最终文本。
pub async fn stream_plain_chat<L: LlmChat>(
    llm: &L,
    messages: &[ChatMessage],
    on_event: &mut (dyn FnMut(StreamEvent) + Send),
) -> Result<String> {
    let agent_msgs: Vec<AgentMsg> = messages
        .iter()
        .map(|m| AgentMsg::Plain(m.clone()))
        .collect();
    let resp = llm.stream_chat_with_tools(&agent_msgs, &[], on_event).await?;
    resp.content.ok_or_else(|| anyhow::anyhow!("LLM 响应缺少 content"))
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

impl LlmChat for Llm {
    /// 带工具调用的多轮对话：模型可返回文本与/或一组工具调用。
    async fn chat_with_tools(
        &self,
        messages: &[AgentMsg],
        tools: &[ToolDef],
    ) -> Result<ChatResponse> {
        match self {
            Llm::OpenAiCompat {
                base_url,
                api_key,
                model,
            } => {
                let resp = Client::new()
                    .post(format!("{base_url}/chat/completions"))
                    .bearer_auth(api_key)
                    .json(&openai_body_with_tools(model, messages, tools))
                    .send()
                    .await
                    .context("调用 OpenAI 兼容接口失败")?;
                let status = resp.status();
                let body: serde_json::Value = resp.json().await.context("解析 LLM 响应失败")?;
                if !status.is_success() {
                    anyhow::bail!("LLM 返回错误 {status}: {body}");
                }
                parse_openai_response(&body)
            }
            Llm::Anthropic { api_key, model } => {
                let resp = Client::new()
                    .post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&anthropic_body_with_tools(model, messages, tools))
                    .send()
                    .await
                    .context("调用 Anthropic 接口失败")?;
                let status = resp.status();
                let body: serde_json::Value = resp.json().await.context("解析 LLM 响应失败")?;
                if !status.is_success() {
                    anyhow::bail!("LLM 返回错误 {status}: {body}");
                }
                parse_anthropic_response(&body)
            }
        }
    }

    /// 流式版：SSE 逐 token 转发思考/正文；SSE 中途失败回退非流式重试一次。
    async fn stream_chat_with_tools(
        &self,
        messages: &[AgentMsg],
        tools: &[ToolDef],
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<ChatResponse> {
        let result = match self {
            Llm::OpenAiCompat {
                base_url,
                api_key,
                model,
            } => {
                stream_openai_compat(base_url, api_key, model, messages, tools, on_event).await
            }
            Llm::Anthropic { api_key, model } => {
                stream_anthropic(api_key, model, messages, tools, on_event).await
            }
        };
        match result {
            Ok(resp) => Ok(resp),
            Err(e) => {
                // 流式失败（网络中断/解析异常等）→ 同一请求非流式重试一次
                eprintln!("LLM 流式调用失败，回退非流式重试: {e}");
                self.chat_with_tools(messages, tools).await
            }
        }
    }
}

/// 从字节缓冲中切出所有**完整行**（以 `\n` 结尾）并解码交给 `on_line`。
///
/// SSE 数据行以 `\n` 分隔；`\n`（0x0A）绝不会作为 UTF-8 续字节出现，因此在
/// `\n` 处切分不会切开多字节字符——跨网络 chunk 被拆开的中文等字符先留在
/// 字节缓冲里，等字节完整后再整体解码，避免 `from_utf8_lossy` 逐 chunk 处理
/// 产生 U+FFFD（�）。
fn drain_lines(buf: &mut Vec<u8>, on_line: &mut dyn FnMut(String)) {
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line = String::from_utf8_lossy(&buf[..pos])
            .trim_end_matches('\r')
            .to_string();
        buf.drain(..=pos);
        on_line(line);
    }
}

/// OpenAI 兼容端流式调用：`stream: true` + SSE 解析。
async fn stream_openai_compat(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[AgentMsg],
    tools: &[ToolDef],
    on_event: &mut (dyn FnMut(StreamEvent) + Send),
) -> Result<ChatResponse> {
    let mut body = openai_body_with_tools(model, messages, tools);
    body["stream"] = serde_json::Value::Bool(true);
    let resp = Client::new()
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .context("调用 OpenAI 兼容接口失败")?;
    let status = resp.status();
    if !status.is_success() {
        let b: serde_json::Value = resp.json().await.context("解析错误响应失败")?;
        anyhow::bail!("LLM 返回错误 {status}: {b}");
    }
    let mut parser = OpenAiStreamParser::default();
    // 字节缓冲：多字节 UTF-8 字符可能被拆到相邻 chunk，若逐 chunk 做
    // from_utf8_lossy 会产生 U+FFFD（�）；改为按 `\n`（ASCII，绝不作为
    // UTF-8 续字节）切出完整行后再解码，保证中文等字符不损坏。
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("读取流失败")?;
        buf.extend_from_slice(&chunk);
        drain_lines(&mut buf, &mut |line| {
            if let Some(evt) = parser.push_line(&line) {
                on_event(evt);
            }
        });
    }
    parser.finish()
}

/// Anthropic 端流式调用：`stream: true` + SSE 事件解析。
async fn stream_anthropic(
    api_key: &str,
    model: &str,
    messages: &[AgentMsg],
    tools: &[ToolDef],
    on_event: &mut (dyn FnMut(StreamEvent) + Send),
) -> Result<ChatResponse> {
    let mut body = anthropic_body_with_tools(model, messages, tools);
    body["stream"] = serde_json::Value::Bool(true);
    let resp = Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("调用 Anthropic 接口失败")?;
    let status = resp.status();
    if !status.is_success() {
        let b: serde_json::Value = resp.json().await.context("解析错误响应失败")?;
        anyhow::bail!("LLM 返回错误 {status}: {b}");
    }
    let mut parser = AnthropicStreamParser::default();
    // 同上：字节缓冲 + 完整行解码，避免跨 chunk 的 UTF-8 字符被 lossy 损坏
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("读取流失败")?;
        buf.extend_from_slice(&chunk);
        drain_lines(&mut buf, &mut |line| {
            if let Some(evt) = parser.push_line(&line) {
                on_event(evt);
            }
        });
    }
    parser.finish()
}

/// 解析 OpenAI 兼容响应：content（可空）+ reasoning_content/reasoning + tool_calls。
fn parse_openai_response(body: &serde_json::Value) -> Result<ChatResponse> {
    let msg = &body["choices"][0]["message"];
    let content = msg["content"].as_str().map(str::to_string);
    let reasoning = msg["reasoning_content"]
        .as_str()
        .or_else(|| msg["reasoning"].as_str())
        .map(str::to_string);
    let mut tool_calls = Vec::new();
    if let Some(arr) = msg["tool_calls"].as_array() {
        for tc in arr {
            let id = tc["id"].as_str().unwrap_or_default().to_string();
            let name = tc["function"]["name"].as_str().unwrap_or_default().to_string();
            if name.is_empty() {
                continue;
            }
            // arguments 是 JSON 字符串，解析失败降级为 Null（由工具侧校验兜底）
            let arguments = tc["function"]["arguments"]
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Null);
            tool_calls.push(ToolCallRef { id, name, arguments });
        }
    }
    Ok(ChatResponse {
        content,
        reasoning,
        tool_calls,
    })
}

/// 解析 Anthropic 响应：content blocks 里的 text / thinking / tool_use。
fn parse_anthropic_response(body: &serde_json::Value) -> Result<ChatResponse> {
    let blocks = body["content"]
        .as_array()
        .context("Anthropic 响应缺少 content")?;
    let mut content: Option<String> = None;
    let mut reasoning: Option<String> = None;
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block["type"].as_str() {
            Some("text") => content = Some(block["text"].as_str().unwrap_or_default().to_string()),
            Some("thinking") => {
                reasoning = Some(block["thinking"].as_str().unwrap_or_default().to_string())
            }
            Some("tool_use") => tool_calls.push(ToolCallRef {
                id: block["id"].as_str().unwrap_or_default().to_string(),
                name: block["name"].as_str().unwrap_or_default().to_string(),
                arguments: block["input"].clone(),
            }),
            _ => {}
        }
    }
    Ok(ChatResponse {
        content,
        reasoning,
        tool_calls,
    })
}

/// OpenAI 兼容 SSE 流解析状态机（纯逻辑，可单测）。
#[derive(Default)]
struct OpenAiStreamParser {
    content: String,
    reasoning: String,
    tool_calls: Vec<OpenAiToolAcc>,
}

#[derive(Default)]
struct OpenAiToolAcc {
    id: String,
    name: String,
    arguments: String,
}

impl OpenAiStreamParser {
    /// 处理一行 SSE（`data: {...}` 或空行/注释）；产出事件则返回。
    fn push_line(&mut self, line: &str) -> Option<StreamEvent> {
        let line = line.trim();
        if !line.starts_with("data:") {
            return None;
        }
        let data = line["data:".len()..].trim();
        if data == "[DONE]" {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(data).ok()?;
        let delta = &v["choices"][0]["delta"];
        let mut evt = None;
        if let Some(t) = delta["content"].as_str() {
            if !t.is_empty() {
                self.content.push_str(t);
                evt = Some(StreamEvent::Content(t.to_string()));
            }
        }
        if let Some(t) = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
        {
            if !t.is_empty() {
                self.reasoning.push_str(t);
                evt = Some(StreamEvent::Thinking(t.to_string()));
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for tc in calls {
                let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                while self.tool_calls.len() <= idx {
                    self.tool_calls.push(OpenAiToolAcc::default());
                }
                if let Some(id) = tc["id"].as_str() {
                    if !id.is_empty() {
                        self.tool_calls[idx].id.push_str(id);
                    }
                }
                if let Some(name) = tc["function"]["name"].as_str() {
                    if !name.is_empty() {
                        self.tool_calls[idx].name.push_str(name);
                    }
                }
                if let Some(args) = tc["function"]["arguments"].as_str() {
                    if !args.is_empty() {
                        self.tool_calls[idx].arguments.push_str(args);
                    }
                }
            }
        }
        evt
    }

    /// 流结束：汇总为完整响应。
    fn finish(self) -> Result<ChatResponse> {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .filter(|t| !t.name.is_empty())
            .enumerate()
            .map(|(i, t)| ToolCallRef {
                id: if t.id.is_empty() {
                    format!("call_{i}")
                } else {
                    t.id
                },
                name: t.name,
                arguments: serde_json::from_str(&t.arguments).unwrap_or(serde_json::Value::Null),
            })
            .collect();
        Ok(ChatResponse {
            content: if self.content.is_empty() {
                None
            } else {
                Some(self.content)
            },
            reasoning: if self.reasoning.is_empty() {
                None
            } else {
                Some(self.reasoning)
            },
            tool_calls,
        })
    }
}

/// Anthropic SSE 流解析状态机（纯逻辑，可单测）。
#[derive(Default)]
struct AnthropicStreamParser {
    content: String,
    thinking: String,
    tool_uses: Vec<AnthropicToolAcc>,
}

#[derive(Default)]
struct AnthropicToolAcc {
    id: String,
    name: String,
    input: String,
}

impl AnthropicStreamParser {
    /// 处理一行 SSE（`data: {...}`）；产出事件则返回。事件类型以 data JSON 的 `type` 为准。
    fn push_line(&mut self, line: &str) -> Option<StreamEvent> {
        let line = line.trim();
        if !line.starts_with("data:") {
            return None;
        }
        let data = line["data:".len()..].trim();
        let v: serde_json::Value = serde_json::from_str(data).ok()?;
        let idx = v["index"].as_u64().unwrap_or(0) as usize;
        match v["type"].as_str() {
            Some("content_block_start") => match v["content_block"]["type"].as_str() {
                Some("tool_use") => {
                    while self.tool_uses.len() <= idx {
                        self.tool_uses.push(AnthropicToolAcc::default());
                    }
                    self.tool_uses[idx].id = v["content_block"]["id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    self.tool_uses[idx].name = v["content_block"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                }
                _ => {}
            },
            Some("content_block_delta") => match v["delta"]["type"].as_str() {
                Some("text_delta") => {
                    let t = v["delta"]["text"].as_str().unwrap_or_default();
                    if !t.is_empty() {
                        self.content.push_str(t);
                        return Some(StreamEvent::Content(t.to_string()));
                    }
                }
                Some("thinking_delta") => {
                    let t = v["delta"]["thinking"].as_str().unwrap_or_default();
                    if !t.is_empty() {
                        self.thinking.push_str(t);
                        return Some(StreamEvent::Thinking(t.to_string()));
                    }
                }
                Some("input_json_delta") => {
                    let t = v["delta"]["partial_json"].as_str().unwrap_or_default();
                    if !t.is_empty() {
                        while self.tool_uses.len() <= idx {
                            self.tool_uses.push(AnthropicToolAcc::default());
                        }
                        self.tool_uses[idx].input.push_str(t);
                    }
                }
                _ => {}
            },
            _ => {}
        }
        None
    }

    /// 流结束：汇总为完整响应。
    fn finish(self) -> Result<ChatResponse> {
        let tool_calls = self
            .tool_uses
            .into_iter()
            .filter(|t| !t.name.is_empty())
            .map(|t| ToolCallRef {
                id: t.id,
                name: t.name,
                arguments: serde_json::from_str(&t.input).unwrap_or(serde_json::Value::Null),
            })
            .collect();
        Ok(ChatResponse {
            content: if self.content.is_empty() {
                None
            } else {
                Some(self.content)
            },
            reasoning: if self.thinking.is_empty() {
                None
            } else {
                Some(self.thinking)
            },
            tool_calls,
        })
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

/// 构造带工具的 OpenAI 兼容请求体（`chat/completions` + `tools`）。
fn openai_body_with_tools(model: &str, messages: &[AgentMsg], tools: &[ToolDef]) -> serde_json::Value {
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| match m {
            AgentMsg::Plain(cm) => json!({ "role": cm.role, "content": cm.content }),
            AgentMsg::ToolCalls { content, calls } => json!({
                // OpenAI 兼容格式要求 content 字段存在；纯工具轮次用空串
                "role": "assistant",
                "content": content.clone().unwrap_or_default(),
                "tool_calls": calls.iter().map(|c| json!({
                    "id": c.id,
                    "type": "function",
                    "function": {
                        "name": c.name,
                        "arguments": serde_json::to_string(&c.arguments).unwrap_or_default(),
                    },
                })).collect::<Vec<_>>(),
            }),
            AgentMsg::ToolResult { call_id, content, .. } => json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": content,
            }),
        })
        .collect();
    let tools: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            })
        })
        .collect();
    json!({ "model": model, "messages": msgs, "tools": tools })
}

/// 构造带工具的 Anthropic 请求体（`messages` + `tools`）：system 拆顶层，
/// assistant 工具轮次拆成 text + tool_use 块，工具结果用 `tool_result` 用户块。
fn anthropic_body_with_tools(
    model: &str,
    messages: &[AgentMsg],
    tools: &[ToolDef],
) -> serde_json::Value {
    let system = messages
        .iter()
        .filter_map(|m| match m {
            AgentMsg::Plain(cm) if cm.role == Role::System => Some(cm.content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| !matches!(m, AgentMsg::Plain(cm) if cm.role == Role::System))
        .map(|m| match m {
            AgentMsg::Plain(cm) => json!({ "role": cm.role, "content": cm.content }),
            AgentMsg::ToolCalls { content, calls } => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = content {
                    if !t.is_empty() {
                        blocks.push(json!({ "type": "text", "text": t }));
                    }
                }
                for c in calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": c.id,
                        "name": c.name,
                        "input": c.arguments,
                    }));
                }
                json!({ "role": "assistant", "content": blocks })
            }
            AgentMsg::ToolResult { call_id, content, .. } => json!({
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": call_id, "content": content }],
            }),
        })
        .collect();
    let tools: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            })
        })
        .collect();
    json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": system,
        "messages": msgs,
        "tools": tools,
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

    // ---------- 工具调用 wire 格式 ----------

    fn tool_def(name: &str) -> ToolDef {
        ToolDef {
            name: name.to_string(),
            description: format!("{name} 描述"),
            parameters: json!({ "type": "object", "properties": { "q": { "type": "string" } } }),
        }
    }

    fn call(id: &str, name: &str) -> ToolCallRef {
        ToolCallRef {
            id: id.to_string(),
            name: name.to_string(),
            arguments: json!({ "q": "注意力" }),
        }
    }

    #[test]
    fn openai_tools_body_maps_all_msg_kinds() {
        let msgs = vec![
            AgentMsg::Plain(msg(Role::System, "sys")),
            AgentMsg::Plain(msg(Role::User, "hi")),
            AgentMsg::ToolCalls {
                content: None,
                calls: vec![call("call_1", "search_papers")],
            },
            AgentMsg::ToolResult {
                call_id: "call_1".into(),
                name: "search_papers".into(),
                content: "[1] 结果".into(),
            },
        ];
        let body = openai_body_with_tools("gpt-4o-mini", &msgs, &[tool_def("search_papers")]);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 4);
        // 工具定义
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "search_papers");
        assert!(body["tools"][0]["function"]["parameters"]["type"].is_string());
        // assistant 工具轮次：content 空串 + tool_calls
        assert_eq!(arr[2]["role"], "assistant");
        assert_eq!(arr[2]["content"], "");
        assert_eq!(arr[2]["tool_calls"][0]["function"]["name"], "search_papers");
        // arguments 序列化为 JSON 字符串
        assert_eq!(arr[2]["tool_calls"][0]["function"]["arguments"], r#"{"q":"注意力"}"#);
        // 工具结果
        assert_eq!(arr[3]["role"], "tool");
        assert_eq!(arr[3]["tool_call_id"], "call_1");
        assert_eq!(arr[3]["content"], "[1] 结果");
    }

    #[test]
    fn anthropic_tools_body_splits_system_and_blocks() {
        let msgs = vec![
            AgentMsg::Plain(msg(Role::System, "sys prompt")),
            AgentMsg::Plain(msg(Role::User, "hi")),
            AgentMsg::ToolCalls {
                content: Some("我先查一下".into()),
                calls: vec![call("tu_1", "get_outline")],
            },
            AgentMsg::ToolResult {
                call_id: "tu_1".into(),
                name: "get_outline".into(),
                content: "目录".into(),
            },
        ];
        let body = anthropic_body_with_tools("claude-sonnet-4-6", &msgs, &[tool_def("get_outline")]);
        assert_eq!(body["system"], "sys prompt");
        assert_eq!(body["tools"][0]["name"], "get_outline");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 3); // system 已拆出
        // assistant：text + tool_use 两个块
        assert_eq!(arr[1]["content"][0]["type"], "text");
        assert_eq!(arr[1]["content"][0]["text"], "我先查一下");
        assert_eq!(arr[1]["content"][1]["type"], "tool_use");
        assert_eq!(arr[1]["content"][1]["id"], "tu_1");
        // 工具结果：user + tool_result 块
        assert_eq!(arr[2]["role"], "user");
        assert_eq!(arr[2]["content"][0]["type"], "tool_result");
        assert_eq!(arr[2]["content"][0]["tool_use_id"], "tu_1");
    }

    #[test]
    fn parse_openai_response_reads_content_reasoning_and_calls() {
        let body = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "reasoning_content": "思考中…",
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": { "name": "web_search", "arguments": "{\"query\":\"transformer\"}" },
                    }],
                }
            }]
        });
        let resp = parse_openai_response(&body).unwrap();
        assert!(resp.content.is_none());
        assert_eq!(resp.reasoning.as_deref(), Some("思考中…"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_9");
        assert_eq!(resp.tool_calls[0].name, "web_search");
        assert_eq!(resp.tool_calls[0].arguments["query"], "transformer");
    }

    #[test]
    fn parse_openai_response_handles_bad_arguments_json() {
        let body = json!({
            "choices": [{ "message": {
                "content": "ok",
                "tool_calls": [{
                    "id": "c1",
                    "function": { "name": "x", "arguments": "not-json" },
                }],
            } }]
        });
        let resp = parse_openai_response(&body).unwrap();
        assert_eq!(resp.content.as_deref(), Some("ok"));
        assert_eq!(resp.tool_calls[0].arguments, serde_json::Value::Null);
    }

    #[test]
    fn parse_anthropic_response_reads_blocks() {
        let body = json!({
            "content": [
                { "type": "thinking", "thinking": "思考中…" },
                { "type": "tool_use", "id": "tu_2", "name": "read_section", "input": { "topic": "方法" } },
                { "type": "text", "text": "这是回答" },
            ]
        });
        let resp = parse_anthropic_response(&body).unwrap();
        assert_eq!(resp.content.as_deref(), Some("这是回答"));
        assert_eq!(resp.reasoning.as_deref(), Some("思考中…"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "read_section");
        assert_eq!(resp.tool_calls[0].arguments["topic"], "方法");
    }

    #[test]
    fn agent_msg_roundtrips_all_variants() {
        let msgs = vec![
            AgentMsg::Plain(msg(Role::System, "sys")),
            AgentMsg::ToolCalls {
                content: None,
                calls: vec![call("c1", "search_papers")],
            },
            AgentMsg::ToolResult {
                call_id: "c1".into(),
                name: "search_papers".into(),
                content: "[1] 结果".into(),
            },
        ];
        let json = serde_json::to_string(&msgs).unwrap();
        let back: Vec<AgentMsg> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), 3);
        match &back[0] {
            AgentMsg::Plain(cm) => assert_eq!(cm.content, "sys"),
            _ => panic!("应为 Plain"),
        }
        match &back[1] {
            AgentMsg::ToolCalls { content, calls } => {
                assert!(content.is_none());
                assert_eq!(calls[0].name, "search_papers");
                assert_eq!(calls[0].arguments["q"], "注意力");
            }
            _ => panic!("应为 ToolCalls"),
        }
        match &back[2] {
            AgentMsg::ToolResult { call_id, content, .. } => {
                assert_eq!(call_id, "c1");
                assert_eq!(content, "[1] 结果");
            }
            _ => panic!("应为 ToolResult"),
        }
    }

    // ---------- SSE 流解析 ----------

    #[test]
    fn openai_sse_parses_content_reasoning_and_tool_calls() {
        let mut p = OpenAiStreamParser::default();
        let mut events = Vec::new();
        for line in [
            r#"data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning_content":"中…"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"回答"}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"web_search","arguments":"{\"query\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}"#,
            "data: [DONE]",
        ] {
            if let Some(e) = p.push_line(line) {
                events.push(e);
            }
        }
        assert_eq!(events.len(), 3); // thinking×2 + content×1（tool_calls 不产事件）
        let resp = p.finish().unwrap();
        assert_eq!(resp.reasoning.as_deref(), Some("思考中…"));
        assert_eq!(resp.content.as_deref(), Some("回答"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "c1");
        assert_eq!(resp.tool_calls[0].name, "web_search");
        assert_eq!(resp.tool_calls[0].arguments["query"], "x");
    }

    #[test]
    fn openai_sse_bad_arguments_falls_back_to_null() {
        let mut p = OpenAiStreamParser::default();
        p.push_line(r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"x","arguments":"not-json"}}]}}]}"#)
            .is_none();
        let resp = p.finish().unwrap();
        assert_eq!(resp.tool_calls[0].arguments, serde_json::Value::Null);
    }

    #[test]
    fn anthropic_sse_parses_thinking_text_and_tool_use() {
        let mut p = AnthropicStreamParser::default();
        let mut events = Vec::new();
        for line in [
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"好了"}}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read_section","input":{}}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"topic\":"}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"方法\"}"}}"#,
            r#"data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"最终答案"}}"#,
        ] {
            if let Some(e) = p.push_line(line) {
                events.push(e);
            }
        }
        assert_eq!(events.len(), 3); // thinking×2 + text×1
        let resp = p.finish().unwrap();
        assert_eq!(resp.reasoning.as_deref(), Some("想好了"));
        assert_eq!(resp.content.as_deref(), Some("最终答案"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "tu1");
        assert_eq!(resp.tool_calls[0].name, "read_section");
        assert_eq!(resp.tool_calls[0].arguments["topic"], "方法");
    }

    #[test]
    fn drain_lines_preserves_multibyte_chars_across_chunks() {
        // 模拟：一条含中文的 SSE 数据行被网络拆成多个 chunk，且 3 字节中文字符
        // 恰好被切开（0xE6 0xAD 0x90 是「正」的 UTF-8 编码前两字节+后一字节）
        let mut buf: Vec<u8> = Vec::new();
        // 「正」= E6 AD A3：第一段只给首字节 E6，模拟字符被网络拆开
        buf.extend_from_slice("data: {\"content\":\"".as_bytes());
        buf.extend_from_slice(&[0xE6]);
        // 第二段补全「正」的剩余字节 + 下一个字符「确」
        buf.extend_from_slice(&[0xAD, 0xA3]);
        buf.extend_from_slice("确\"}\n".as_bytes());
        let mut lines = Vec::new();
        drain_lines(&mut buf, &mut |l| lines.push(l));
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("正确"), "跨 chunk 的中文字符不应损坏: {:?}", lines[0]);
        assert!(!lines[0].contains('\u{fffd}'), "不应出现 U+FFFD 替换符");
        assert!(buf.is_empty(), "缓冲应被清空");
    }

    #[test]
    fn drain_lines_keeps_partial_tail_in_buffer() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice("data: x\n".as_bytes());
        buf.extend_from_slice("data: 未完".as_bytes());
        let mut lines = Vec::new();
        drain_lines(&mut buf, &mut |l| lines.push(l));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "data: x");
        // 未以 \n 结尾的尾部保留在字节缓冲（可能含半截字符，等下一 chunk 补全）
        assert!(!buf.is_empty());
    }

    #[tokio::test]
    async fn default_streaming_impl_emits_content_once() {
        // 只实现 chat_with_tools 的假 LLM：stream_chat_with_tools 默认实现应整体发一次 Content
        struct PlainLlm;
        impl LlmChat for PlainLlm {
            async fn chat_with_tools(
                &self,
                _m: &[AgentMsg],
                _t: &[ToolDef],
            ) -> Result<ChatResponse> {
                Ok(ChatResponse {
                    content: Some("非流式回答".into()),
                    reasoning: None,
                    tool_calls: vec![],
                })
            }
        }
        let mut events = Vec::new();
        let resp = PlainLlm
            .stream_chat_with_tools(&[], &[], &mut |e| events.push(e))
            .await
            .unwrap();
        assert_eq!(resp.content.as_deref(), Some("非流式回答"));
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Content(t) => assert_eq!(t, "非流式回答"),
            _ => panic!("应为 Content 事件"),
        }
    }
}
