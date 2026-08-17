//! 联网搜索：移植自 DSH 的 `dsh-web-search-deepseek`（协议级复用）。
//!
//! 通过 Anthropic 兼容 Messages API 调用原生服务端工具 `web_search`
//! （`type: web_search_20250305`），解析结构化 `web_search_tool_result` 块。
//! DeepSeek（`https://api.deepseek.com/anthropic/v1`）与 Anthropic
//! （`https://api.anthropic.com/v1`）共用同一请求/解析逻辑，仅 base_url / key / model 不同。
//!
//! 与 DSH 一致的语义：
//! - **严格模式**：响应不含 `web_search_tool_result` 块即报错，绝不从模型文本抓取 URL；
//! - 摘录来自 text 块的 `citations[]`（`url → cited_text`，首个生效）按 URL 关联；
//! - 结果按 URL 去重（一次请求多次搜索可能重复出现同一页面）；
//! - 结果数量上限由调用方（产品）决定，不在模型侧暴露。

use serde_json::json;
use std::collections::{HashMap, HashSet};

/// 一次 `web_search` 返回的来源数量上限（面向产品，不面向模型）。
pub const WEB_SEARCH_MAX_RESULTS: usize = 8;
/// Messages 请求生成 token 上限（DSH 默认值）。
const NATIVE_SEARCH_MAX_TOKENS: u32 = 4096;
/// 单次请求 `web_search` 服务端工具使用上限（DSH 默认值）。
const NATIVE_SEARCH_MAX_USES: u32 = 5;
/// `anthropic-version` 头值。
const API_VERSION: &str = "2023-06-01";

/// 一条搜索结果（已去重、已关联摘录）。
#[derive(Debug, Clone)]
pub struct NativeSearchSource {
    pub url: String,
    pub title: Option<String>,
    pub snippet: Option<String>,
    pub published_at: Option<String>,
}

/// 一次搜索的规范化结果。
#[derive(Debug, Clone)]
pub struct NativeSearchResult {
    pub sources: Vec<NativeSearchSource>,
}

/// 发起一次原生搜索（DeepSeek 或 Anthropic 端点，协议一致）。
pub async fn native_search(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    query: &str,
    max_results: usize,
) -> Result<NativeSearchResult, String> {
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
    let resp = http
        .post(format!("{base_url}/messages"))
        .header("x-api-key", api_key)
        .header("authorization", format!("Bearer {api_key}"))
        .header("anthropic-version", API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("联网搜索请求失败: {e}"))?;
    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析联网搜索响应失败: {e}"))?;
    if !status.is_success() {
        let detail = resp_body["error"]["message"]
            .as_str()
            .or_else(|| resp_body["message"].as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&resp_body.to_string())
            .to_string();
        return Err(format!("搜索服务返回错误（HTTP {status}）: {detail}"));
    }
    map_native_response(&resp_body, max_results)
}

/// 解析 Anthropic Messages 响应 → 去重、摘录关联的来源列表。
/// 严格模式：无 `web_search_tool_result` 块 → 报错（DSH 同款语义）。
fn map_native_response(
    body: &serde_json::Value,
    max_results: usize,
) -> Result<NativeSearchResult, String> {
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

    let result_blocks: Vec<&serde_json::Value> = blocks
        .iter()
        .filter(|b| b["type"] == "web_search_tool_result")
        .collect();
    if result_blocks.is_empty() {
        return Err("搜索未返回结果块（未触发原生搜索），请换个说法重试".to_string());
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut sources = Vec::new();
    'outer: for block in result_blocks {
        if let Some(items) = block["content"].as_array() {
            for item in items {
                if item["type"] != "web_search_result" {
                    continue;
                }
                let url = item["url"].as_str().unwrap_or_default();
                if url.is_empty() || !seen.insert(url.to_string()) {
                    continue;
                }
                sources.push(NativeSearchSource {
                    url: url.to_string(),
                    title: item["title"]
                        .as_str()
                        .filter(|t| !t.is_empty())
                        .map(str::to_string),
                    snippet: snippets.get(url).cloned(),
                    published_at: item["page_age"]
                        .as_str()
                        .filter(|t| !t.is_empty())
                        .map(str::to_string),
                });
                if sources.len() >= max_results {
                    break 'outer;
                }
            }
        }
    }
    Ok(NativeSearchResult { sources })
}

/// 把搜索结果格式化为面向模型的 markdown 来源列表（附引用指引）。
pub fn format_search_result(result: &NativeSearchResult) -> String {
    if result.sources.is_empty() {
        return "联网没有搜到相关结果，可换个关键词重试。".to_string();
    }
    let mut out = format!("联网搜索到 {} 条相关结果：\n", result.sources.len());
    for (i, s) in result.sources.iter().enumerate() {
        let title = s.title.as_deref().unwrap_or(&s.url);
        let meta = s
            .published_at
            .as_deref()
            .map(|d| format!("（{d}）"))
            .unwrap_or_default();
        out.push_str(&format!("{}. [{}]({}){}\n", i + 1, title, s.url, meta));
        if let Some(snip) = &s.snippet {
            out.push_str(&format!("   摘录：{}\n", crate::qa::truncate(snip, 300)));
        }
    }
    out.push_str("请在回答中以 markdown 链接形式引用来源 URL。");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_response() -> serde_json::Value {
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
    fn maps_sources_dedupes_and_joins_snippets() {
        let result = map_native_response(&sample_response(), 8).unwrap();
        assert_eq!(result.sources.len(), 2);
        assert_eq!(result.sources[0].url, "https://a.example/1");
        assert_eq!(result.sources[0].title.as_deref(), Some("结果 A"));
        assert_eq!(result.sources[0].snippet.as_deref(), Some("结果 A 的摘录"));
        assert_eq!(result.sources[0].published_at.as_deref(), Some("3 days ago"));
        // 无 page_age → None
        assert!(result.sources[1].published_at.is_none());
        // 无 URL 的条目被跳过
        assert!(!result.sources.iter().any(|s| s.url.is_empty()));
    }

    #[test]
    fn dedupes_same_url_across_searches() {
        let mut body = sample_response();
        // 第二次搜索重复返回同一 URL
        body["content"][0]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type": "web_search_result",
                "url": "https://a.example/1",
                "title": "重复",
            }));
        let result = map_native_response(&body, 8).unwrap();
        assert_eq!(result.sources.len(), 2);
    }

    #[test]
    fn respects_max_results() {
        let result = map_native_response(&sample_response(), 1).unwrap();
        assert_eq!(result.sources.len(), 1);
    }

    #[test]
    fn strict_mode_errors_without_result_blocks() {
        let body = json!({ "content": [{ "type": "text", "text": "没搜到结构化结果" }] });
        let err = map_native_response(&body, 8).unwrap_err();
        assert!(err.contains("未返回结果块"));
    }

    #[test]
    fn format_search_result_has_links_and_guide() {
        let result = map_native_response(&sample_response(), 8).unwrap();
        let text = format_search_result(&result);
        assert!(text.contains("[结果 A](https://a.example/1)"));
        assert!(text.contains("摘录"));
        assert!(text.contains("markdown 链接"));
    }
}
