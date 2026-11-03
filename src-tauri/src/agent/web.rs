//! 联网搜索与网页抓取。
//!
//! 两个搜索后端（由设置中的 `web_search_provider` 选择）：
//! - **DeepSeek Search API**：`POST {base}/v1/tools/search`，返回结构化结果
//!   （标题、URL、短/长摘要、发布时间、站点、权威性）。官方文档：
//!   <https://api-docs.deepseek.com/zh-cn/guides/search/>
//! - **Anthropic Messages 原生工具**：`web_search_20250305` 服务端工具，
//!   解析 `web_search_tool_result` 块。
//!
//! 网页抓取：
//! - **DeepSeek Fetch API**：`POST {base}/v1/tools/fetch`，返回 Markdown 正文；
//! - `web_fetch` 工具在此接口不可用时回退到本地 HTML 提取（见 `tools.rs`）。
//!
//! 约束：
//! - **严格模式**：搜索响应没有结构化结果时直接报错，绝不从模型文本抓取 URL；
//! - 结果按 URL 去重；返回条数由调用方（用户设置）决定；
//! - 错误信息面向用户（401/402/429 等给出可操作提示），不泄露 API Key。

use crate::settings::{WebSearchConfig, DEEPSEEK_DEFAULT_BASE_URL};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// DeepSeek Search API 单次请求允许的最大条数（官方文档）。
pub const DEEPSEEK_SEARCH_MAX_RESULTS: usize = 50;
/// Messages 请求生成 token 上限。
const NATIVE_SEARCH_MAX_TOKENS: u32 = 4096;
/// 单次请求 `web_search` 服务端工具使用上限。
const NATIVE_SEARCH_MAX_USES: u32 = 5;
/// `anthropic-version` 头值。
const API_VERSION: &str = "2023-06-01";
/// 搜索请求超时。
const SEARCH_TIMEOUT: Duration = Duration::from_secs(60);
/// 网页抓取请求超时。
const FETCH_TIMEOUT: Duration = Duration::from_secs(90);
/// 模型侧展示的摘要截断长度（字符）。
const SUMMARY_CHARS: usize = 600;

/// 一条搜索结果（已去重，三种后端统一结构）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchSource {
    pub url: String,
    pub title: Option<String>,
    /// 短摘要（DeepSeek `snippet` / Anthropic 引用文本）。
    pub snippet: Option<String>,
    /// 长摘要（DeepSeek `summary`，适合给模型阅读）。
    pub summary: Option<String>,
    /// 网页正文（DeepSeek `need_content=true` 时返回；当前搜索请求不开启）。
    pub content: Option<String>,
    /// 发布时间（已规范化为 `YYYY-MM-DD`，无法解析时保留原值）。
    pub published_at: Option<String>,
    /// 站点名称（DeepSeek 返回）。
    pub site_name: Option<String>,
    /// 网页权威性 0-4（DeepSeek 返回；None 表示未知）。
    pub authority: Option<i64>,
}

/// 一次搜索的规范化结果。
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// 实际使用的后端：`deepseek` / `anthropic`。
    pub provider: String,
    pub sources: Vec<SearchSource>,
}

impl SearchResult {
    /// 面向用户的 provider 名称。
    pub fn provider_label(&self) -> &'static str {
        provider_label(&self.provider)
    }
}

/// 抓取结果（DeepSeek Fetch API）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedPage {
    pub title: Option<String>,
    pub content: String,
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "DeepSeek 搜索 API",
        "anthropic" => "Anthropic 原生搜索",
        _ => "联网搜索",
    }
}

/// 按设置选择后端并执行一次搜索。
pub async fn search(
    http: &reqwest::Client,
    config: &WebSearchConfig,
    query: &str,
    max_results: usize,
) -> Result<SearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("搜索词不能为空".to_string());
    }
    if query.chars().count() > 128 {
        return Err("搜索词过长（DeepSeek Search 最多 128 个字符），请精简后重试".to_string());
    }
    let max_results = max_results.clamp(1, DEEPSEEK_SEARCH_MAX_RESULTS);

    match config.provider.as_str() {
        "deepseek" => {
            let sources = deepseek_search(
                http,
                &config.base_url,
                &config.api_key,
                query,
                max_results,
            )
            .await?;
            Ok(SearchResult {
                provider: "deepseek".to_string(),
                sources,
            })
        }
        "anthropic" => {
            let model = config
                .model
                .as_deref()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("claude-sonnet-4-6");
            let sources = anthropic_native_search(
                http,
                &config.base_url,
                &config.api_key,
                model,
                query,
                max_results,
            )
            .await?;
            Ok(SearchResult {
                provider: "anthropic".to_string(),
                sources,
            })
        }
        other => Err(format!("未知的联网搜索 provider: {other}")),
    }
}

/// DeepSeek 官方 Base URL 规范化为根地址（去掉末尾 `/v1`、`/anthropic/v1`）。
///
/// Provider 的 base_url 可能写成 `https://api.deepseek.com`、
/// `https://api.deepseek.com/v1` 或旧版 Anthropic 兼容端点
/// `https://api.deepseek.com/anthropic/v1`，统一还原为根地址后再拼接
/// `/v1/tools/search`、`/v1/tools/fetch`。
pub fn deepseek_root(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return DEEPSEEK_DEFAULT_BASE_URL.to_string();
    }
    // 顺序重要：先匹配更长的 `/anthropic/v1`，否则会被 `/v1` 截断成 `/anthropic`。
    for suffix in ["/anthropic/v1", "/v1", "/anthropic"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            base = stripped.trim_end_matches('/').to_string();
            break;
        }
    }
    if base.is_empty() {
        DEEPSEEK_DEFAULT_BASE_URL.to_string()
    } else {
        base
    }
}

/// 构造 DeepSeek Search 请求体（纯函数，便于测试）。
fn deepseek_search_body(query: &str, count: usize) -> Value {
    json!({
        "query": query,
        "count": count.clamp(1, DEEPSEEK_SEARCH_MAX_RESULTS),
        // 正文按需通过 Fetch API 获取，避免一次搜索返回过多内容撑爆上下文。
        "need_content": false,
    })
}

/// 发起 DeepSeek Search API 请求。
pub async fn deepseek_search(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchSource>, String> {
    let (status, body) = deepseek_post(
        http,
        base_url,
        "/v1/tools/search",
        api_key,
        deepseek_search_body(query, max_results),
        SEARCH_TIMEOUT,
    )
    .await
    .map_err(|e| format!("DeepSeek 搜索请求失败: {e}"))?;
    if !status.is_success() {
        return Err(deepseek_error("搜索", status, &body));
    }
    parse_deepseek_results(&body, max_results)
}

/// 解析 DeepSeek Search API 响应 → 去重后的来源列表。
fn parse_deepseek_results(
    body: &Value,
    max_results: usize,
) -> Result<Vec<SearchSource>, String> {
    let results = body["results"]
        .as_array()
        .ok_or_else(|| "DeepSeek 搜索响应缺少 results 字段".to_string())?;

    let opt_str = |item: &Value, key: &str| {
        item[key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut sources = Vec::new();
    for item in results {
        let url = item["url"].as_str().map(str::trim).unwrap_or_default();
        if url.is_empty() || !seen.insert(url.to_string()) {
            continue;
        }
        sources.push(SearchSource {
            url: url.to_string(),
            title: opt_str(item, "title"),
            snippet: opt_str(item, "snippet"),
            summary: opt_str(item, "summary"),
            content: opt_str(item, "content"),
            published_at: opt_str(item, "date").map(|d| normalize_date(&d)),
            site_name: opt_str(item, "site_name"),
            authority: item["authority"].as_i64().filter(|a| *a >= 0),
        });
        if sources.len() >= max_results {
            break;
        }
    }
    Ok(sources)
}

/// 把 RFC 3339 时间规范化为日期；无法解析时保留原值。
fn normalize_date(raw: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| raw.to_string())
}

/// 发起 DeepSeek Fetch API 请求，把网页转成 Markdown 正文。
pub async fn deepseek_fetch(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    url: &str,
) -> Result<FetchedPage, String> {
    let (status, body) = deepseek_post(
        http,
        base_url,
        "/v1/tools/fetch",
        api_key,
        json!({ "url": url }),
        FETCH_TIMEOUT,
    )
    .await
    .map_err(|e| format!("DeepSeek 抓取请求失败: {e}"))?;
    if !status.is_success() {
        return Err(deepseek_error("抓取", status, &body));
    }
    let content = body["content"].as_str().unwrap_or_default().trim();
    if content.is_empty() {
        return Err("DeepSeek 抓取未返回可用正文（页面可能为脚本渲染或无可提取内容）".to_string());
    }
    Ok(FetchedPage {
        title: body["title"]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
        content: content.to_string(),
    })
}

/// DeepSeek 工具接口通用 POST：返回状态码与解析后的 JSON。
///
/// 失败响应也尽量解析为 JSON，以便把官方错误信息透传给用户；
/// 非 JSON 响应折叠到 `raw` 字段，避免二次解析错误掩盖真实状态码。
async fn deepseek_post(
    http: &reqwest::Client,
    base_url: &str,
    path: &str,
    api_key: &str,
    body: Value,
    timeout: Duration,
) -> Result<(reqwest::StatusCode, Value), String> {
    let endpoint = format!("{}{path}", deepseek_root(base_url));
    let resp = http
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let value = serde_json::from_str::<Value>(&text)
        .unwrap_or_else(|_| json!({ "raw": crate::qa::truncate(&text, 500) }));
    Ok((status, value))
}

/// 把 DeepSeek 的 HTTP 错误翻译为可执行的中文提示。
fn deepseek_error(action: &str, status: reqwest::StatusCode, body: &Value) -> String {
    let detail = body["error"]["message"]
        .as_str()
        .or_else(|| body["message"].as_str())
        .or_else(|| body["raw"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let hint = match status.as_u16() {
        400 => "请求参数不合法",
        401 => "API Key 无效或未配置，请在设置中检查 DeepSeek Provider",
        402 => "DeepSeek 账户余额不足，请充值后重试",
        403 => "请求被安全策略拒绝",
        404 if action == "抓取" => "未能抓取该网页（链接不可用、被站点拦截或页面无可提取正文）",
        404 => "Search 接口不存在，请检查 Provider 的 Base URL",
        408 => "请求体读取超时，请稍后重试",
        413 => "请求体超过大小限制",
        429 => "请求过于频繁（触发 QPS 限制），请稍后重试",
        500 => "DeepSeek 服务内部错误，请稍后重试",
        504 => "DeepSeek 下游请求超时，请稍后重试",
        _ => "请求失败",
    };
    match detail {
        Some(detail) => format!(
            "DeepSeek {action}失败（HTTP {}）：{hint}（{detail}）",
            status.as_u16()
        ),
        None => format!(
            "DeepSeek {action}失败（HTTP {}）：{hint}",
            status.as_u16()
        ),
    }
}

/// 发起 Anthropic 原生搜索（`web_search_20250305` 服务端工具）。
pub async fn anthropic_native_search(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchSource>, String> {
    let body = json!({
        "model": model,
        "max_tokens": NATIVE_SEARCH_MAX_TOKENS,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "text",
                "text": format!("Perform a web search for the query: {query}"),
            }],
        }],
        "tools": [{
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": NATIVE_SEARCH_MAX_USES,
        }],
    });
    let endpoint = format!("{}/messages", base_url.trim_end_matches('/'));
    let resp = http
        .post(endpoint)
        .header("x-api-key", api_key)
        .header("authorization", format!("Bearer {api_key}"))
        .header("anthropic-version", API_VERSION)
        .json(&body)
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("联网搜索请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取联网搜索响应失败: {e}"))?;
    let resp_body: Value = serde_json::from_str(&text).unwrap_or_else(|_| {
        json!({ "raw": crate::qa::truncate(&text, 500) })
    });
    if !status.is_success() {
        return Err(anthropic_error(status, &resp_body));
    }
    map_native_response(&resp_body, max_results)
}

/// 解析 Anthropic Messages 响应 → 去重、摘录关联的来源列表。
/// 严格模式：无 `web_search_tool_result` 块 → 报错。
fn map_native_response(
    body: &Value,
    max_results: usize,
) -> Result<Vec<SearchSource>, String> {
    let blocks = body["content"]
        .as_array()
        .ok_or_else(|| "搜索响应缺少 content".to_string())?;

    // 摘录：遍历 text 块的 citations[]，url → cited_text（首个生效）
    let mut snippets: HashMap<String, String> = HashMap::new();
    for block in blocks {
        if block["type"] != "text" {
            continue;
        }
        if let Some(cites) = block["citations"].as_array() {
            for cite in cites {
                if let (Some(url), Some(text)) = (cite["url"].as_str(), cite["cited_text"].as_str())
                {
                    if !url.is_empty() && !text.is_empty() {
                        snippets
                            .entry(url.to_string())
                            .or_insert_with(|| text.to_string());
                    }
                }
            }
        }
    }

    let result_blocks: Vec<&Value> = blocks
        .iter()
        .filter(|b| b["type"] == "web_search_tool_result")
        .collect();
    if result_blocks.is_empty() {
        return Err("搜索未返回结果块（未触发原生搜索），请换个说法重试".to_string());
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut sources = Vec::new();
    let mut tool_error: Option<String> = None;
    'outer: for block in result_blocks {
        // 服务端工具执行失败时 content 是错误对象，而不是结果数组。
        if block["content"]["type"] == "web_search_tool_result_error" {
            tool_error = block["content"]["error_code"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some("unknown".to_string()));
            continue;
        }
        if let Some(items) = block["content"].as_array() {
            for item in items {
                if item["type"] != "web_search_result" {
                    continue;
                }
                let url = item["url"].as_str().unwrap_or_default();
                if url.is_empty() || !seen.insert(url.to_string()) {
                    continue;
                }
                sources.push(SearchSource {
                    url: url.to_string(),
                    title: item["title"]
                        .as_str()
                        .filter(|t| !t.is_empty())
                        .map(str::to_string),
                    snippet: snippets.get(url).cloned(),
                    summary: None,
                    content: None,
                    published_at: item["page_age"]
                        .as_str()
                        .filter(|t| !t.is_empty())
                        .map(str::to_string),
                    site_name: None,
                    authority: None,
                });
                if sources.len() >= max_results {
                    break 'outer;
                }
            }
        }
    }
    if sources.is_empty() {
        if let Some(code) = tool_error {
            return Err(format!("搜索服务返回错误（{code}），请稍后重试"));
        }
    }
    Ok(sources)
}

/// 把 Anthropic 的 HTTP 错误翻译为可执行的中文提示。
fn anthropic_error(status: reqwest::StatusCode, body: &Value) -> String {
    let detail = body["error"]["message"]
        .as_str()
        .or_else(|| body["message"].as_str())
        .or_else(|| body["raw"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let hint = match status.as_u16() {
        400 => "请求参数不合法",
        401 => "API Key 无效或未配置，请在设置中检查 Anthropic Provider",
        403 => "请求被拒绝",
        404 => "接口不存在，请检查 Base URL",
        429 => "请求过于频繁，请稍后重试",
        500 | 502 | 503 | 529 => "搜索服务暂时不可用，请稍后重试",
        _ => "搜索失败",
    };
    match detail {
        Some(detail) => format!(
            "Anthropic 搜索失败（HTTP {}）：{hint}（{detail}）",
            status.as_u16()
        ),
        None => format!(
            "Anthropic 搜索失败（HTTP {}）：{hint}",
            status.as_u16()
        ),
    }
}

/// 把搜索结果格式化为面向模型的 markdown 来源列表（附引用指引）。
pub fn format_search_result(result: &SearchResult) -> String {
    if result.sources.is_empty() {
        return "联网搜索没有找到相关结果，可换个关键词或使用 site:/after:/before: 等检索语法重试。"
            .to_string();
    }
    let mut out = format!(
        "联网搜索到 {} 条相关结果（{}）：\n",
        result.sources.len(),
        result.provider_label()
    );
    for (i, source) in result.sources.iter().enumerate() {
        let title = source.title.as_deref().unwrap_or(&source.url);
        let mut meta_parts: Vec<String> = Vec::new();
        if let Some(site) = source.site_name.as_deref() {
            meta_parts.push(site.to_string());
        }
        if let Some(date) = source.published_at.as_deref() {
            meta_parts.push(date.to_string());
        }
        if source.authority.is_some_and(|authority| authority >= 3) {
            meta_parts.push("高权威".to_string());
        }
        let meta = if meta_parts.is_empty() {
            String::new()
        } else {
            format!("（{}）", meta_parts.join(" · "))
        };
        out.push_str(&format!(
            "{}. [{}]({}){}\n",
            i + 1,
            title,
            source.url,
            meta
        ));
        // 长摘要专门为模型阅读设计；没有时退回短摘要。
        if let Some(summary) = source
            .summary
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| source.snippet.as_deref().filter(|s| !s.is_empty()))
        {
            out.push_str(&format!(
                "   摘要：{}\n",
                crate::qa::truncate(summary, SUMMARY_CHARS)
            ));
        }
    }
    out.push_str("需要原文细节时可用 web_fetch 抓取；回答请以 markdown 链接引用来源 URL。\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(url: &str, title: &str) -> SearchSource {
        SearchSource {
            url: url.to_string(),
            title: Some(title.to_string()),
            snippet: Some(format!("{title} 的短摘要")),
            summary: None,
            content: None,
            published_at: None,
            site_name: None,
            authority: None,
        }
    }

    fn sample_response() -> Value {
        json!({
            "content": [
                {
                    "type": "web_search_tool_result",
                    "content": [
                        {
                            "type": "web_search_result",
                            "url": "https://a.example/1",
                            "title": "结果 A",
                            "page_age": "3 days ago",
                        },
                        {
                            "type": "web_search_result",
                            "url": "https://b.example/2",
                            "title": "结果 B",
                            "page_age": "",
                        },
                        {
                            "type": "web_search_result",
                            "url": "",
                            "title": "无 URL 应跳过",
                        },
                    ],
                },
                {
                    "type": "text",
                    "text": "合成回答",
                    "citations": [
                        { "url": "https://a.example/1", "cited_text": "结果 A 的摘录" },
                        { "url": "https://b.example/2", "cited_text": "结果 B 的摘录" },
                    ],
                },
            ]
        })
    }

    #[test]
    fn maps_native_sources_dedupes_and_joins_snippets() {
        let sources = map_native_response(&sample_response(), 8).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].url, "https://a.example/1");
        assert_eq!(sources[0].title.as_deref(), Some("结果 A"));
        assert_eq!(sources[0].snippet.as_deref(), Some("结果 A 的摘录"));
        assert_eq!(sources[0].published_at.as_deref(), Some("3 days ago"));
        assert!(sources[1].published_at.is_none());
        assert!(!sources.iter().any(|s| s.url.is_empty()));
    }

    #[test]
    fn native_dedupes_same_url_across_searches() {
        let mut body = sample_response();
        body["content"][0]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type": "web_search_result",
                "url": "https://a.example/1",
                "title": "重复",
            }));
        let sources = map_native_response(&body, 8).unwrap();
        assert_eq!(sources.len(), 2);
    }

    #[test]
    fn native_respects_max_results() {
        let sources = map_native_response(&sample_response(), 1).unwrap();
        assert_eq!(sources.len(), 1);
    }

    #[test]
    fn native_strict_mode_errors_without_result_blocks() {
        let body = json!({ "content": [{ "type": "text", "text": "没搜到结构化结果" }] });
        let err = map_native_response(&body, 8).unwrap_err();
        assert!(err.contains("未返回结果块"));
    }

    #[test]
    fn native_tool_error_is_reported() {
        let body = json!({
            "content": [{
                "type": "web_search_tool_result",
                "content": {
                    "type": "web_search_tool_result_error",
                    "error_code": "max_uses_exceeded",
                },
            }]
        });
        let err = map_native_response(&body, 8).unwrap_err();
        assert!(err.contains("max_uses_exceeded"));
    }

    #[test]
    fn deepseek_root_strips_version_suffixes() {
        assert_eq!(
            deepseek_root("https://api.deepseek.com"),
            "https://api.deepseek.com"
        );
        assert_eq!(
            deepseek_root("https://api.deepseek.com/"),
            "https://api.deepseek.com"
        );
        assert_eq!(
            deepseek_root("https://api.deepseek.com/v1"),
            "https://api.deepseek.com"
        );
        assert_eq!(
            deepseek_root("https://api.deepseek.com/anthropic/v1"),
            "https://api.deepseek.com"
        );
        assert_eq!(
            deepseek_root("https://proxy.example.com/deepseek/v1/"),
            "https://proxy.example.com/deepseek"
        );
        assert_eq!(deepseek_root(""), DEEPSEEK_DEFAULT_BASE_URL);
        assert_eq!(deepseek_root("   "), DEEPSEEK_DEFAULT_BASE_URL);
    }

    #[test]
    fn deepseek_search_body_clamps_count_and_does_not_request_content() {
        let body = deepseek_search_body("DeepSeek 模型", 200);
        assert_eq!(body["query"], "DeepSeek 模型");
        assert_eq!(body["count"], 50);
        assert_eq!(body["need_content"], false);
        assert_eq!(deepseek_search_body("q", 0)["count"], 1);
    }

    fn deepseek_response() -> Value {
        json!({
            "results": [
                {
                    "rerank_score": 2.4,
                    "title": "DeepSeek V4 模型发布",
                    "url": "https://example.com/deepseek-v4",
                    "snippet": "短摘要",
                    "summary": "长摘要，适合给模型阅读。",
                    "content": "",
                    "site_name": "Example News",
                    "site_icon": null,
                    "date": "2026-06-01T00:00:00+00:00",
                    "authority": 3,
                },
                {
                    "rerank_score": 1.0,
                    "title": "重复链接",
                    "url": "https://example.com/deepseek-v4",
                    "snippet": "",
                    "summary": "",
                    "content": "",
                    "site_name": null,
                    "site_icon": null,
                    "date": null,
                    "authority": -1,
                },
                {
                    "rerank_score": 1.2,
                    "title": "无日期结果",
                    "url": "https://example.com/other",
                    "snippet": "另一条",
                    "summary": "",
                    "content": "",
                    "site_name": null,
                    "site_icon": null,
                    "date": "not-a-date",
                    "authority": 1,
                },
            ]
        })
    }

    #[test]
    fn parses_deepseek_results_with_metadata_and_dedupes() {
        let sources = parse_deepseek_results(&deepseek_response(), 8).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].url, "https://example.com/deepseek-v4");
        assert_eq!(sources[0].title.as_deref(), Some("DeepSeek V4 模型发布"));
        assert_eq!(sources[0].summary.as_deref(), Some("长摘要，适合给模型阅读。"));
        assert_eq!(sources[0].site_name.as_deref(), Some("Example News"));
        assert_eq!(sources[0].published_at.as_deref(), Some("2026-06-01"));
        assert_eq!(sources[0].authority, Some(3));
        // 未知权威性 / 无法解析的日期按约定处理
        assert_eq!(sources[1].authority, Some(1));
        assert_eq!(sources[1].published_at.as_deref(), Some("not-a-date"));
    }

    #[test]
    fn deepseek_respects_max_results_and_empty_results() {
        let sources = parse_deepseek_results(&deepseek_response(), 1).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(parse_deepseek_results(&json!({ "results": [] }), 8)
            .unwrap()
            .is_empty());
        assert!(parse_deepseek_results(&json!({}), 8).is_err());
    }

    #[test]
    fn deepseek_error_maps_actionable_hints() {
        let err = deepseek_error(
            "搜索",
            reqwest::StatusCode::PAYMENT_REQUIRED,
            &json!({ "error": { "message": "Insufficient Balance" } }),
        );
        assert!(err.contains("余额不足"));
        assert!(err.contains("Insufficient Balance"));
        let err = deepseek_error(
            "抓取",
            reqwest::StatusCode::NOT_FOUND,
            &json!({ "error": { "message": "page not found" } }),
        );
        assert!(err.contains("未能抓取该网页"));
        let err = deepseek_error(
            "搜索",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            &json!({}),
        );
        assert!(err.contains("QPS"));
    }

    #[test]
    fn formats_sources_with_summary_metadata_and_links() {
        let mut first = source("https://a.example/1", "结果 A");
        first.summary = Some("长摘要内容".to_string());
        first.site_name = Some("站点 A".to_string());
        first.published_at = Some("2026-06-01".to_string());
        first.authority = Some(4);
        let result = SearchResult {
            provider: "deepseek".to_string(),
            sources: vec![first, source("https://b.example/2", "结果 B")],
        };
        let text = format_search_result(&result);
        assert!(text.contains("DeepSeek 搜索 API"));
        assert!(text.contains("[结果 A](https://a.example/1)"));
        assert!(text.contains("站点 A · 2026-06-01 · 高权威"));
        assert!(text.contains("长摘要内容"));
        assert!(text.contains("结果 B 的短摘要"));
        assert!(text.contains("markdown 链接"));
    }

    #[test]
    fn format_empty_results_guides_retry() {
        let result = SearchResult {
            provider: "anthropic".to_string(),
            sources: vec![],
        };
        let text = format_search_result(&result);
        assert!(text.contains("没有找到相关结果"));
        assert!(text.contains("site:"));
    }

    #[tokio::test]
    async fn search_rejects_overlong_query_before_request() {
        let config = WebSearchConfig {
            provider: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "http://127.0.0.1:1".to_string(),
            model: None,
            count: 8,
        };
        let http = reqwest::Client::new();
        let err = search(&http, &config, &"a".repeat(129), 8)
            .await
            .unwrap_err();
        assert!(err.contains("128"), "{err}");
    }

    /// 启动一次性本地 HTTP 服务：返回 (base_url, 读取到的请求文本的 JoinHandle)。
    async fn mock_server(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 1024];
            let mut expected_len: Option<usize> = None;
            loop {
                let n = stream.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
                if expected_len.is_none() {
                    if let Some(header_end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&buffer[..header_end]);
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        expected_len = Some(header_end + 4 + content_length);
                    }
                }
                if expected_len.is_some_and(|end| buffer.len() >= end) {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buffer).to_string();
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            request
        });
        (format!("http://{address}"), handle)
    }

    #[tokio::test]
    async fn deepseek_client_uses_official_endpoints_and_bearer_auth() {
        let search_body = r#"{"results":[{"title":"T","url":"https://example.com/1","snippet":"S","summary":"L","site_name":"E","date":"2026-01-02T03:04:05+00:00","authority":3}]}"#;
        let (base_url, handle) = mock_server("200 OK", search_body).await;
        let http = reqwest::Client::new();
        let sources = deepseek_search(&http, &base_url, "sk-test", "DeepSeek 模型", 5)
            .await
            .unwrap();
        let request = handle.await.unwrap();
        assert!(request.starts_with("POST /v1/tools/search "), "{request}");
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer sk-test"));
        assert!(request.contains("\"count\":5"), "{request}");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].title.as_deref(), Some("T"));

        let fetch_body = r##"{"title":"Page","content":"# Hello"}"##;
        let (base_url, handle) = mock_server("200 OK", fetch_body).await;
        let page = deepseek_fetch(&http, &base_url, "sk-test", "https://example.com/p")
            .await
            .unwrap();
        let request = handle.await.unwrap();
        assert!(request.starts_with("POST /v1/tools/fetch "), "{request}");
        assert!(request.contains("\"url\":\"https://example.com/p\""));
        assert_eq!(page.title.as_deref(), Some("Page"));
        assert_eq!(page.content, "# Hello");
    }
}
