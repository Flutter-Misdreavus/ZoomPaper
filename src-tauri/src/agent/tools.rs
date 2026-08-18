//! agent 工具注册表：本地论文库工具 + 联网工具。
//!
//! 设计（借鉴 DSH `dsh-tool-web` 的约定）：
//! - 每个工具 = 名称 + 描述 + JSON Schema + 执行逻辑；
//! - **注册跟随启用状态**：联网工具仅在设置中可用时注册，`read_selection` 仅在用户
//!   选中段落非空时注册；system prompt 的指引段与之保持一致；
//! - 工具失败 → 错误文本回喂模型（模型可换工具或如实说明），不中断 agent 循环；
//! - 返回本地内容的工具自带全局编号 `[n]` 上下文块与结构化 [`Citation`]，
//!   编号由调用方传入的 `offset` 决定（引用列表顺序累计，最终答案复用编号）。

use crate::agent::{html_extract, web};
use crate::db::Db;
use std::io::Read;
use crate::qa::{truncate, Citation, SelectionInput};
use crate::rag;
use crate::settings::Settings;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::Duration;

/// 单次工具结果的文本上限（字符），防上下文膨胀。
pub const TOOL_RESULT_MAX_CHARS: usize = 12_000;
/// web_fetch 总下载字节硬上限（防呆；到达后停止下载，用已提取内容输出）。
const FETCH_DOWNLOAD_MAX_BYTES: usize = 10 * 1024 * 1024;
/// web_fetch 提取文本预算（字符）：到达即断流。128k 可覆盖 GitHub README 等靠后正文。
const FETCH_EXTRACT_TEXT_BUDGET: usize = 128_000;
/// 引用 snippet 截断长度（字符）。
const SNIPPET_CHARS: usize = 300;
/// 用户标注/译文总字符预算。
const USER_DATA_MAX_CHARS: usize = 6_000;
/// 用户标注最多条数。
const ANNOTATIONS_MAX_ITEMS: usize = 20;

/// 工具执行上下文（借用数据库/设置/HTTP 客户端与会话上下文）。
pub struct ToolCtx<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub http: &'a reqwest::Client,
    /// 当前会话绑定的论文 id（单篇阅读场景）；跨论文为 None
    pub paper_id: Option<&'a str>,
    /// 用户选中段落（阅读页「就地提问」的上下文引用）
    pub selections: &'a [SelectionInput],
}

/// 工具输出：回喂模型的文本 + 本地引用 + 前端展示摘要。
#[derive(Debug)]
pub struct ToolOutput {
    pub text: String,
    pub citations: Vec<Citation>,
    pub summary: String,
}

/// 具体工具标识（枚举分派而非函数指针，类型安全）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    SearchPapers,
    ReadSection,
    GetOutline,
    GetPaperMeta,
    ListPapers,
    ReadAnnotations,
    ReadTranslation,
    WebSearch,
    WebFetch,
    ReadSelection,
    AskUser,
}

impl ToolKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::SearchPapers => "search_papers",
            Self::ReadSection => "read_section",
            Self::GetOutline => "get_outline",
            Self::GetPaperMeta => "get_paper_meta",
            Self::ListPapers => "list_papers",
            Self::ReadAnnotations => "read_annotations",
            Self::ReadTranslation => "read_translation",
            Self::WebSearch => "web_search",
            Self::WebFetch => "web_fetch",
            Self::ReadSelection => "read_selection",
            Self::AskUser => "ask_user",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::SearchPapers => "在本地论文知识库中做语义检索，返回相关段落（带 [n] 引用编号）。",
            Self::ReadSection => "精读某篇论文中与某个主题最相关的章节全文（可多章节），返回带 [n] 引用编号。",
            Self::GetOutline => "获取某篇论文的章节目录（TOC），了解论文结构。",
            Self::GetPaperMeta => "获取某篇论文的元数据：标题、作者、摘要、解析状态。",
            Self::ListPapers => "列出论文库中的论文（可按标题关键词过滤），拿到论文 id 与标题。",
            Self::ReadAnnotations => "读取用户在这篇论文上的高亮与笔记（了解用户关注点）。",
            Self::ReadTranslation => "读取这篇论文的中文译文缓存分块（可带关键词过滤）。",
            Self::WebSearch => "联网搜索资料（返回来源列表与摘录）。",
            Self::WebFetch => "抓取指定 URL 的网页正文（转 markdown）。",
            Self::ReadSelection => "读取用户选中的一段论文原文（带页码）。",
            Self::AskUser => "向用户提问澄清（问题有歧义或需要用户选择研究方向时使用，每轮最多一次）。",
        }
    }

    pub fn parameters(self) -> Value {
        let obj = |required: &[&str], props: Value| {
            json!({
                "type": "object",
                "required": required,
                "properties": props,
                "additionalProperties": false,
            })
        };
        let paper_id = json!({
            "type": "string",
            "description": "论文 id（来自 list_papers / 对话上下文）；省略时使用当前会话绑定的论文，跨论文会话必须指定",
        });
        match self {
            Self::SearchPapers => obj(
                &["query"],
                json!({
                    "query": { "type": "string", "description": "检索关键词（论文内容相关）" },
                    "paper_id": paper_id,
                    "top_k": { "type": "number", "description": "返回条数，1-10，默认 5" },
                }),
            ),
            Self::ReadSection => obj(
                &["topic"],
                json!({
                    "topic": { "type": "string", "description": "要精读的主题或章节名" },
                    "paper_id": paper_id,
                    "max_sections": { "type": "number", "description": "最多展开章节数，1-4，默认 2" },
                }),
            ),
            Self::GetOutline => obj(&[], json!({ "paper_id": paper_id })),
            Self::GetPaperMeta => obj(&[], json!({ "paper_id": paper_id })),
            Self::ListPapers => obj(
                &[],
                json!({
                    "query": { "type": "string", "description": "按标题模糊过滤，可省略" },
                }),
            ),
            Self::ReadAnnotations => obj(&[], json!({ "paper_id": paper_id })),
            Self::ReadTranslation => obj(
                &[],
                json!({
                    "paper_id": paper_id,
                    "keywords": { "type": "string", "description": "要查找的关键词（匹配英文原文），可省略" },
                    "limit": { "type": "number", "description": "最多返回分块数，1-20，默认 10" },
                }),
            ),
            Self::WebSearch => obj(
                &["query"],
                json!({ "query": { "type": "string", "description": "搜索关键词" } }),
            ),
            Self::WebFetch => obj(
                &["url"],
                json!({ "url": { "type": "string", "description": "要抓取的 http/https 链接" } }),
            ),
            Self::ReadSelection => obj(
                &["index"],
                json!({
                    "index": { "type": "number", "description": "用户选中段落的编号（从 0 开始）" },
                }),
            ),
            Self::AskUser => obj(
                &["question"],
                json!({
                    "question": { "type": "string", "description": "向用户提出的澄清问题，应具体、可回答" },
                    "options": { "type": "array", "items": { "type": "string" }, "maxItems": 4, "description": "候选选项（用户点击即答）；省略则仅自由输入" },
                    "free_text": { "type": "boolean", "description": "是否允许用户自由输入，默认 true" },
                }),
            ),
        }
    }
}

/// 构建当前会话可用的工具列表（注册跟随启用状态）。
pub fn build_tools(
    settings: &Settings,
    paper_id: Option<&str>,
    selections: &[SelectionInput],
) -> Vec<ToolKind> {
    let mut tools = vec![
        ToolKind::SearchPapers,
        ToolKind::ReadSection,
        ToolKind::GetOutline,
        ToolKind::GetPaperMeta,
        ToolKind::ListPapers,
        ToolKind::ReadAnnotations,
        ToolKind::ReadTranslation,
        ToolKind::AskUser,
    ];
    if settings.web_search_available().is_some() {
        tools.push(ToolKind::WebSearch);
        tools.push(ToolKind::WebFetch);
    }
    if !selections.is_empty() {
        tools.push(ToolKind::ReadSelection);
    }
    let _ = paper_id; // 工具不因当前论文而增减（跨论文也保留本地工具）
    tools
}

/// 费曼学习场景的工具集：本地研读 + 联网（按启用状态），
/// **不含** `ask_user`（费曼是老师↔学生对话流，不允许澄清打断）与 `read_selection`（无选中段落）。
pub fn build_feynman_tools(settings: &Settings) -> Vec<ToolKind> {
    let mut tools = vec![
        ToolKind::SearchPapers,
        ToolKind::ReadSection,
        ToolKind::GetOutline,
        ToolKind::GetPaperMeta,
        ToolKind::ListPapers,
        ToolKind::ReadAnnotations,
        ToolKind::ReadTranslation,
    ];
    if settings.web_search_available().is_some() {
        tools.push(ToolKind::WebSearch);
        tools.push(ToolKind::WebFetch);
    }
    tools
}

/// 执行一个工具（顺序执行；`offset` 为当前全局引用编号起点，工具内部编号顺延）。
///
/// 注意：`AskUser` 由循环层（agent::drive_loop）拦截处理，不经过本函数。
pub async fn execute_tool(
    kind: ToolKind,
    ctx: &ToolCtx<'_>,
    args: &Value,
    offset: usize,
) -> Result<ToolOutput, String> {
    match kind {
        ToolKind::SearchPapers => search_papers(ctx, args, offset),
        ToolKind::ReadSection => read_section(ctx, args, offset),
        ToolKind::GetOutline => get_outline(ctx, args),
        ToolKind::GetPaperMeta => get_paper_meta(ctx, args),
        ToolKind::ListPapers => list_papers(ctx, args),
        ToolKind::ReadAnnotations => read_annotations(ctx, args, offset),
        ToolKind::ReadTranslation => read_translation(ctx, args, offset),
        ToolKind::WebSearch => web_search(ctx, args).await,
        ToolKind::WebFetch => web_fetch(ctx, args).await,
        ToolKind::ReadSelection => read_selection(ctx, args, offset),
        ToolKind::AskUser => Err("ask_user 应由 agent 循环层处理".to_string()),
    }
}

// ---------- 工具实现 ----------

/// 解析论文 id：优先参数，其次会话绑定论文。
fn resolve_paper(ctx: &ToolCtx<'_>, args: &Value) -> Result<String, String> {
    match args["paper_id"].as_str() {
        Some(p) if !p.is_empty() => Ok(p.to_string()),
        _ => ctx
            .paper_id
            .map(str::to_string)
            .ok_or_else(|| "未指定论文（可先调用 list_papers 查看论文 id 再传入 paper_id）".to_string()),
    }
}

/// 查论文标题（不存在返回 None）。
fn paper_title(conn: &rusqlite::Connection, paper_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT title FROM papers WHERE id = ?1",
        [paper_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn page_str(page: Option<i64>) -> String {
    page.map(|p| format!("第 {} 页", p + 1))
        .unwrap_or_else(|| "页码未知".to_string())
}

/// 把检索命中格式化为编号上下文 + 引用（纯函数，便于测试）。
fn format_hits_context(hits: &[crate::db::models::SearchHit], offset: usize) -> (String, Vec<Citation>) {
    let mut text = format!("【本地检索命中 {} 条】\n", hits.len());
    let mut citations = Vec::with_capacity(hits.len());
    for (i, h) in hits.iter().enumerate() {
        let idx = i + 1 + offset;
        text.push_str(&format!(
            "[{idx}] 论文《{}》· {} · {}：\n{}\n\n",
            h.paper_title, page_str(h.page_idx), h.section, h.content
        ));
        citations.push(Citation {
            index: idx,
            chunk_id: h.chunk_id,
            paper_id: h.paper_id.clone(),
            paper_title: h.paper_title.clone(),
            section: h.section.clone(),
            page_idx: h.page_idx,
            snippet: truncate(&h.content, SNIPPET_CHARS),
        });
    }
    (text, citations)
}

/// 1. 本地语义检索。
fn search_papers(ctx: &ToolCtx<'_>, args: &Value, offset: usize) -> Result<ToolOutput, String> {
    let query = args["query"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 query 参数".to_string())?;
    let top_k = args["top_k"].as_u64().unwrap_or(5).min(10) as usize;
    let paper_id = args["paper_id"].as_str().map(str::to_string);
    let conn = ctx.db.conn();
    let hits =
        rag::search(&conn, query, top_k, paper_id.as_deref()).map_err(|e| format!("检索失败: {e}"))?;
    if hits.is_empty() {
        return Ok(ToolOutput {
            text: "本地知识库没有检索到相关内容，可更换关键词、用 read_section 精读章节或联网搜索。"
                .to_string(),
            citations: vec![],
            summary: "未命中".to_string(),
        });
    }
    let (text, citations) = format_hits_context(&hits, offset);
    Ok(ToolOutput {
        text: truncate(&text, TOOL_RESULT_MAX_CHARS),
        citations,
        summary: format!("命中 {} 条", hits.len()),
    })
}

/// 把展开的章节格式化为编号上下文 + 引用（纯函数，便于测试）。
/// `hits` 用于给章节取页码（该章节内首个命中）。
fn format_sections_context(
    title: &str,
    paper_id: &str,
    sections: &[(String, String)],
    hits: &[crate::db::models::SearchHit],
    offset: usize,
) -> (String, Vec<Citation>) {
    let mut text = String::new();
    let mut citations = Vec::with_capacity(sections.len());
    for (i, (section, content)) in sections.iter().enumerate() {
        let idx = i + 1 + offset;
        let page = hits
            .iter()
            .find(|h| h.section == *section)
            .and_then(|h| h.page_idx);
        text.push_str(&format!(
            "[{idx}] 论文《{title}》· {} · 章节「{section}」：\n{content}\n\n",
            page_str(page)
        ));
        citations.push(Citation {
            index: idx,
            chunk_id: -1,
            paper_id: paper_id.to_string(),
            paper_title: title.to_string(),
            section: section.clone(),
            page_idx: page,
            snippet: truncate(content, SNIPPET_CHARS),
        });
    }
    (text, citations)
}

/// 2. 精读章节：检索命中的章节升级为章节全文（复用费曼的 expand_sections）。
fn read_section(ctx: &ToolCtx<'_>, args: &Value, offset: usize) -> Result<ToolOutput, String> {
    let paper_id = resolve_paper(ctx, args)?;
    let topic = args["topic"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 topic 参数".to_string())?;
    let max_sections = args["max_sections"].as_u64().unwrap_or(2).min(4) as usize;
    let conn = ctx.db.conn();
    let hits = rag::search(&conn, topic, crate::feynman::TOP_K, Some(&paper_id))
        .map_err(|e| format!("检索失败: {e}"))?;
    if hits.is_empty() {
        return Ok(ToolOutput {
            text: format!("论文中未检索到与「{topic}」相关的章节，可换关键词或查看 get_outline 的章节名。"),
            citations: vec![],
            summary: "未命中章节".to_string(),
        });
    }
    let title = paper_title(&conn, &paper_id).unwrap_or_else(|| paper_id.clone());
    let sections = rag::expand_sections(
        &conn,
        &paper_id,
        &hits,
        max_sections,
        crate::feynman::SECTION_MAX_CHARS,
        crate::feynman::SECTION_CTX_TOTAL_MAX,
    )
    .map_err(|e| format!("展开章节失败: {e}"))?;
    let (text, citations) = format_sections_context(&title, &paper_id, &sections, &hits, offset);
    Ok(ToolOutput {
        text: truncate(&text, TOOL_RESULT_MAX_CHARS),
        citations,
        summary: format!("{} 个章节", sections.len()),
    })
}

/// 3. 章节目录。
fn get_outline(ctx: &ToolCtx<'_>, args: &Value) -> Result<ToolOutput, String> {
    let paper_id = resolve_paper(ctx, args)?;
    let conn = ctx.db.conn();
    let title = paper_title(&conn, &paper_id).unwrap_or_else(|| paper_id.clone());
    let sections =
        rag::sections_for_paper(&conn, &paper_id).map_err(|e| format!("读取目录失败: {e}"))?;
    if sections.is_empty() {
        return Ok(ToolOutput {
            text: "该论文没有可用的章节目录（可能尚未完成解析或索引）。".to_string(),
            citations: vec![],
            summary: "无目录".to_string(),
        });
    }
    let mut text = format!("论文《{title}》章节目录（{} 章）：\n", sections.len());
    for (i, s) in sections.iter().enumerate() {
        text.push_str(&format!("{}. {}\n", i + 1, s));
    }
    text.push_str("\n如需精读某章节，可用 read_section 工具传入章节名或主题。");
    Ok(ToolOutput {
        text,
        citations: vec![],
        summary: format!("{} 个章节", sections.len()),
    })
}

/// 4. 论文元数据。
fn get_paper_meta(ctx: &ToolCtx<'_>, args: &Value) -> Result<ToolOutput, String> {
    let paper_id = resolve_paper(ctx, args)?;
    let conn = ctx.db.conn();
    let row = conn
        .query_row(
            "SELECT title, authors, abstract, parse_status FROM papers WHERE id = ?1",
            [&paper_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("查询失败: {e}"))?;
    let Some((title, authors, abstract_text, parse_status)) = row else {
        return Err(format!("论文 {paper_id} 不存在"));
    };
    let mut text = format!("论文《{title}》\n");
    if let Some(a) = authors {
        if !a.trim().is_empty() {
            text.push_str(&format!("作者：{a}\n"));
        }
    }
    text.push_str(&format!("解析状态：{parse_status}\n"));
    if let Some(abs) = abstract_text {
        if !abs.trim().is_empty() {
            text.push_str(&format!("摘要：{}", truncate(&abs, 2_000)));
        }
    }
    Ok(ToolOutput {
        text,
        citations: vec![],
        summary: title,
    })
}

/// 5. 论文列表。
fn list_papers(ctx: &ToolCtx<'_>, args: &Value) -> Result<ToolOutput, String> {
    let filter = args["query"]
        .as_str()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let conn = ctx.db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT id, title, parse_status FROM papers ORDER BY created_at DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut papers: Vec<(String, String, String)> = Vec::new();
    for row in rows {
        let (id, title, status) = row.map_err(|e| e.to_string())?;
        if let Some(f) = &filter {
            if !title.to_lowercase().contains(f) {
                continue;
            }
        }
        papers.push((id, title, status));
        if papers.len() >= 20 {
            break;
        }
    }
    if papers.is_empty() {
        return Ok(ToolOutput {
            text: "论文库为空（或没有匹配的论文）。".to_string(),
            citations: vec![],
            summary: "无论文".to_string(),
        });
    }
    let mut text = format!("论文库共列出 {} 篇：\n", papers.len());
    for (id, title, status) in &papers {
        text.push_str(&format!("- id=`{id}`：《{title}》（{status}）\n"));
    }
    text.push_str("\n需要操作某篇论文时，把它的 id 传给 paper_id 参数。");
    Ok(ToolOutput {
        text: truncate(&text, TOOL_RESULT_MAX_CHARS),
        citations: vec![],
        summary: format!("{} 篇论文", papers.len()),
    })
}

/// 读论文目录下的 JSON 文件（annotations.json / translation.json 等）。
fn read_paper_json(ctx: &ToolCtx<'_>, paper_id: &str, file: &str) -> Result<Option<Value>, String> {
    let md_path: String = {
        let conn = ctx.db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [paper_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("查询失败: {e}"))?
        .ok_or_else(|| format!("论文 {paper_id} 不存在"))?
    };
    let path = Path::new(&md_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(file);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取 {file} 失败: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("解析 {file} 失败: {e}"))
}

/// 6. 用户标注（高亮 + 笔记）。
fn read_annotations(ctx: &ToolCtx<'_>, args: &Value, offset: usize) -> Result<ToolOutput, String> {
    let paper_id = resolve_paper(ctx, args)?;
    let json = read_paper_json(ctx, &paper_id, "annotations.json")?;
    let Some(v) = json else {
        return Ok(ToolOutput {
            text: "该论文还没有阅读标注。".to_string(),
            citations: vec![],
            summary: "无标注".to_string(),
        });
    };
    let highlights = v["highlights"].as_array().cloned().unwrap_or_default();
    if highlights.is_empty() {
        return Ok(ToolOutput {
            text: "该论文的标注文件为空。".to_string(),
            citations: vec![],
            summary: "0 条标注".to_string(),
        });
    }
    // 按创建时间倒序取最近 N 条
    let mut items: Vec<&Value> = highlights.iter().collect();
    items.sort_by(|a, b| {
        b["created_at"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["created_at"].as_i64().unwrap_or(0))
    });
    items.truncate(ANNOTATIONS_MAX_ITEMS);

    let mut text = String::new();
    let mut citations = Vec::new();
    let mut budget = USER_DATA_MAX_CHARS;
    for h in items {
        if budget == 0 {
            break;
        }
        let page = h["page_idx"].as_i64();
        let sel_text = h["text"].as_str().unwrap_or_default();
        if sel_text.trim().is_empty() {
            continue;
        }
        let idx = citations.len() + 1 + offset;
        let note = h["note"]["text"].as_str().unwrap_or_default();
        let block = if note.trim().is_empty() {
            format!(
                "[{idx}] 第 {} 页 · 用户标注：{}\n\n",
                page.map(|p| p + 1).unwrap_or(0),
                sel_text
            )
        } else {
            format!(
                "[{idx}] 第 {} 页 · 用户标注：{}\n    用户笔记：{}\n\n",
                page.map(|p| p + 1).unwrap_or(0),
                sel_text,
                truncate(note, 200)
            )
        };
        if block.chars().count() > budget {
            text.push_str(&truncate(&block, budget));
            budget = 0;
        } else {
            text.push_str(&block);
            budget -= block.chars().count();
        }
        citations.push(Citation {
            index: idx,
            chunk_id: -1,
            paper_id: paper_id.clone(),
            paper_title: paper_title(&ctx.db.conn(), &paper_id)
                .unwrap_or_else(|| paper_id.clone()),
            section: "用户标注".to_string(),
            page_idx: page,
            snippet: truncate(sel_text, SNIPPET_CHARS),
        });
    }
    if citations.is_empty() {
        return Ok(ToolOutput {
            text: "该论文的标注没有可用的文本内容。".to_string(),
            citations: vec![],
            summary: "无文本标注".to_string(),
        });
    }
    let n = citations.len();
    Ok(ToolOutput {
        text,
        citations,
        summary: format!("{n} 条标注"),
    })
}

/// 7. 中文译文缓存（en/zh 分块）。
fn read_translation(ctx: &ToolCtx<'_>, args: &Value, offset: usize) -> Result<ToolOutput, String> {
    let paper_id = resolve_paper(ctx, args)?;
    let keywords = args["keywords"].as_str().map(|s| s.trim().to_lowercase());
    let limit = args["limit"].as_u64().unwrap_or(10).min(20) as usize;
    let json = read_paper_json(ctx, &paper_id, "translation.json")?;
    let Some(v) = json else {
        return Ok(ToolOutput {
            text: "该论文还没有中文译文缓存，可先使用翻译功能。".to_string(),
            citations: vec![],
            summary: "无译文".to_string(),
        });
    };
    let chunks = v["chunks"].as_array().cloned().unwrap_or_default();
    if chunks.is_empty() {
        return Ok(ToolOutput {
            text: "该论文的译文缓存为空。".to_string(),
            citations: vec![],
            summary: "0 块".to_string(),
        });
    }
    let mut selected: Vec<&Value> = chunks
        .iter()
        .filter(|c| match &keywords {
            Some(k) => c["en"]
                .as_str()
                .map(|e| e.to_lowercase().contains(k))
                .unwrap_or(false),
            None => true,
        })
        .collect();
    selected.truncate(limit);

    let mut text = String::new();
    let mut citations = Vec::new();
    let mut budget = USER_DATA_MAX_CHARS;
    for c in &selected {
        if budget == 0 {
            break;
        }
        let en = c["en"].as_str().unwrap_or_default();
        let zh = c["zh"].as_str().unwrap_or_default();
        if en.trim().is_empty() {
            continue;
        }
        let idx = citations.len() + 1 + offset;
        let block = format!("[{idx}] 论文《{}》· 中文译文：\n原文：{}\n译文：{}\n\n",
            paper_title(&ctx.db.conn(), &paper_id).unwrap_or_else(|| paper_id.clone()),
            truncate(en, 600),
            truncate(zh, 600),
        );
        if block.chars().count() > budget {
            text.push_str(&truncate(&block, budget));
            budget = 0;
        } else {
            text.push_str(&block);
            budget -= block.chars().count();
        }
        citations.push(Citation {
            index: idx,
            chunk_id: -1,
            paper_id: paper_id.clone(),
            paper_title: paper_title(&ctx.db.conn(), &paper_id).unwrap_or_else(|| paper_id.clone()),
            section: "中文译文".to_string(),
            page_idx: None,
            snippet: truncate(zh, SNIPPET_CHARS),
        });
    }
    if citations.is_empty() {
        return Ok(ToolOutput {
            text: format!("没有匹配「{}」的译文分块。", keywords.unwrap_or_default()),
            citations: vec![],
            summary: "无匹配".to_string(),
        });
    }
    let n = citations.len();
    Ok(ToolOutput {
        text,
        citations,
        summary: format!("{n} 块译文"),
    })
}

/// 8. 联网搜索（原生搜索，复用 DeepSeek / Anthropic Key）。
async fn web_search(ctx: &ToolCtx<'_>, args: &Value) -> Result<ToolOutput, String> {
    let query = args["query"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 query 参数".to_string())?;
    let (provider, model) = ctx
        .settings
        .web_search_available()
        .ok_or_else(|| "联网搜索未启用，请先在设置页配置（复用 DeepSeek/Anthropic Key）".to_string())?;
    let (base_url, api_key) = match provider.as_str() {
        "deepseek" => ("https://api.deepseek.com/anthropic/v1".to_string(), ctx.settings.api_keys.deepseek.clone()),
        "anthropic" => ("https://api.anthropic.com/v1".to_string(), ctx.settings.api_keys.anthropic.clone()),
        other => return Err(format!("未知的搜索 provider: {other}")),
    };
    let result = web::native_search(
        ctx.http,
        &base_url,
        &api_key,
        &model,
        query,
        web::WEB_SEARCH_MAX_RESULTS,
    )
    .await?;
    let text = web::format_search_result(&result);
    // 摘要收录前 2 个来源 URL（供研究记忆与轨迹展示）
    let urls: Vec<&str> = result.sources.iter().take(2).map(|s| s.url.as_str()).collect();
    let summary = if urls.is_empty() {
        format!("{} 条来源", result.sources.len())
    } else {
        format!("{} 条来源：{}", result.sources.len(), urls.join(", "))
    };
    Ok(ToolOutput {
        text,
        citations: vec![],
        summary,
    })
}

/// 9. 抓取网页正文（静态 HTML → markdown）。
/// blocking 抓取 + 流式提取（在 spawn_blocking 内运行：
/// html5ever Tokenizer 因 tendril 的 NonAtomic 引用计数而 !Send，不能跨 await 持有）。
fn fetch_extract_blocking(
    url: &str,
) -> Result<(String, bool, reqwest::StatusCode), String> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::blocking::Client::new);
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(|e| format!("抓取失败: {e}"))?;
    let status = resp.status();

    // 流式提取：以「提取文本预算」而非「原始字节数」决定停止时机；
    // 大页面（GitHub 等）只需下载到正文为止，彻底摆脱原始字节大小限制。
    let mut extractor = html_extract::HtmlExtractor::new(FETCH_EXTRACT_TEXT_BUDGET);
    let mut reader = resp;
    let mut chunk = [0u8; 8192];
    let mut downloaded = 0usize;
    let mut is_html = false;
    let mut first = true;
    let mut body = String::new();
    let mut hit_cap = false;
    loop {
        let n = reader
            .read(&mut chunk)
            .map_err(|e| format!("读取响应失败: {e}"))?;
        if n == 0 {
            break;
        }
        downloaded += n;
        if first {
            is_html = chunk[0] == b'<';
            first = false;
        }
        if is_html {
            extractor.feed(&chunk[..n]);
            if extractor.stopped() {
                break; // 文本预算达标，断流
            }
        } else {
            body.push_str(&String::from_utf8_lossy(&chunk[..n]));
        }
        if downloaded >= FETCH_DOWNLOAD_MAX_BYTES {
            hit_cap = true;
            break; // 下载硬上限，断流
        }
    }
    if is_html {
        body = extractor.finish();
    }
    Ok((body, hit_cap, status))
}

async fn web_fetch(_ctx: &ToolCtx<'_>, args: &Value) -> Result<ToolOutput, String> {
    let url = args["url"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 url 参数".to_string())?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 链接".to_string());
    }
    // 下载 + 提取整体放入 spawn_blocking（HtmlExtractor 非 Send，不能跨 await 持有）
    let url_owned = url.to_string();
    let (body, hit_cap, status) = tokio::task::spawn_blocking(move || {
        fetch_extract_blocking(&url_owned)
    })
    .await
    .map_err(|e| format!("抓取任务失败: {e}"))??;

    let status_note = if status.is_success() {
        String::new()
    } else {
        format!("（页面返回状态 {status}，内容可能不完整）\n")
    };
    let cap_note = if hit_cap {
        "\n（下载已达上限，内容可能不完整）"
    } else {
        ""
    };
    if body.trim().is_empty() {
        return Ok(ToolOutput {
            text: format!(
                "{status_note}未提取到有效正文内容（页面可能为脚本渲染，或需要登录）。{cap_note}"
            ),
            citations: vec![],
            summary: format!("抓取 {url}（无正文）"),
        });
    }
    Ok(ToolOutput {
        text: truncate(&format!("{status_note}{body}{cap_note}"), TOOL_RESULT_MAX_CHARS),
        citations: vec![],
        summary: format!("抓取 {url}"),
    })
}

/// 10. 用户选中段落（阅读页就地提问）。
fn read_selection(ctx: &ToolCtx<'_>, args: &Value, offset: usize) -> Result<ToolOutput, String> {
    let index = args["index"]
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .ok_or_else(|| "缺少 index 参数".to_string())?;
    let sel = ctx
        .selections
        .get(index)
        .ok_or_else(|| format!("index 越界（共 {} 条选中段落，编号从 0 开始）", ctx.selections.len()))?;
    let text = sel.text.trim();
    if text.is_empty() {
        return Err("该选中段落为空".to_string());
    }
    let paper_title = ctx
        .paper_id
        .and_then(|pid| paper_title(&ctx.db.conn(), pid))
        .unwrap_or_else(|| "当前论文".to_string());
    let idx = 1 + offset;
    let page = sel.page_idx;
    let out_text = format!(
        "[{idx}] 论文《{paper_title}》· {} · 用户选中段落：\n{}",
        page_str(page),
        text
    );
    let citation = Citation {
        index: idx,
        chunk_id: -1,
        paper_id: ctx.paper_id.unwrap_or_default().to_string(),
        paper_title,
        section: "用户选中段落".to_string(),
        page_idx: page,
        snippet: truncate(text, SNIPPET_CHARS),
    };
    Ok(ToolOutput {
        text: out_text,
        citations: vec![citation],
        summary: "选中段落".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::db::models::SearchHit;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO papers (id, title, authors, abstract, pdf_path, md_path, \
             created_at, reading_status, parse_status) \
             VALUES ('p1', '测试论文', '[\"A\"]', '摘要文本', '/x.pdf', '/x.md', 0, 'unread', 'ready')",
            [],
        )
        .unwrap();
        conn
    }

    fn ctx<'a>(
        db: &'a Db,
        settings: &'a Settings,
        selections: &'a [SelectionInput],
        http: &'a reqwest::Client,
    ) -> ToolCtx<'a> {
        ToolCtx {
            db,
            settings,
            http,
            paper_id: Some("p1"),
            selections,
        }
    }

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
    fn tools_build_follows_enablement() {
        let mut s = Settings::default();
        s.web_search_provider = "none".into();
        let tools = build_tools(&s, Some("p1"), &[]);
        assert!(!tools.contains(&ToolKind::WebSearch));
        assert!(tools.contains(&ToolKind::SearchPapers));
        assert!(!tools.contains(&ToolKind::ReadSelection));
        assert!(tools.contains(&ToolKind::AskUser)); // 澄清工具恒可用

        s.web_search_provider = "auto".into();
        s.api_keys.deepseek = "sk-test".into();
        let tools = build_tools(&s, Some("p1"), &[]);
        assert!(tools.contains(&ToolKind::WebSearch));
        assert!(tools.contains(&ToolKind::WebFetch));

        let sel = [SelectionInput {
            text: "选中段落".into(),
            page_idx: Some(2),
        }];
        let tools = build_tools(&s, Some("p1"), &sel);
        assert!(tools.contains(&ToolKind::ReadSelection));
    }

    #[test]
    fn feynman_tools_exclude_ask_user_and_read_selection() {
        let mut s = Settings::default();
        s.web_search_provider = "none".into();
        let tools = build_feynman_tools(&s);
        assert!(tools.contains(&ToolKind::ReadSection));
        assert!(!tools.contains(&ToolKind::AskUser)); // 费曼不允许澄清打断
        assert!(!tools.contains(&ToolKind::ReadSelection)); // 无选中段落
        assert!(!tools.contains(&ToolKind::WebSearch));
        // 启用联网后包含 web 工具
        s.web_search_provider = "auto".into();
        s.api_keys.deepseek = "sk-test".into();
        let tools2 = build_feynman_tools(&s);
        assert!(tools2.contains(&ToolKind::WebSearch));
        assert!(tools2.contains(&ToolKind::WebFetch));
    }

    #[test]
    fn format_hits_context_numbers_and_cites() {
        let hits = vec![
            hit("注意力论文", "Introduction", "第一段内容", Some(0)),
            hit("注意力论文", "Method", "第二段内容", None),
        ];
        let (text, citations) = format_hits_context(&hits, 0);
        assert!(text.contains("[1]"));
        assert!(text.contains("[2]"));
        assert!(text.contains("第 1 页"));
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0].index, 1);
        assert_eq!(citations[1].index, 2);
        assert_eq!(citations[0].page_idx, Some(0));
        // 偏移：后续工具编号顺延
        let (text2, cites2) = format_hits_context(&hits, 2);
        assert!(text2.contains("[3]"));
        assert!(text2.contains("[4]"));
        assert_eq!(cites2[0].index, 3);
    }

    #[test]
    fn format_sections_context_uses_section_page() {
        let hits = vec![
            hit("T", "Method", "method chunk", Some(3)),
            hit("T", "Intro", "intro chunk", Some(0)),
        ];
        let sections = vec![
            ("Method".to_string(), "方法全文…".to_string()),
            ("Intro".to_string(), "引言全文…".to_string()),
        ];
        let (text, citations) = format_sections_context("T", "p1", &sections, &hits, 0);
        assert!(text.contains("章节「Method」"));
        assert!(text.contains("第 4 页")); // Method 命中页 3（0-based）→ 第 4 页
        assert_eq!(citations[0].page_idx, Some(3));
        assert_eq!(citations[1].page_idx, Some(0));
        assert_eq!(citations[0].chunk_id, -1);
        // 偏移
        let (_, cites2) = format_sections_context("T", "p1", &sections, &hits, 1);
        assert_eq!(cites2[0].index, 2);
    }

    #[test]
    fn resolve_paper_prefers_arg_over_context() {
        let conn = setup_db();
        let db = Db::from_connection(conn);
        let settings = Settings::default();
        let http = reqwest::Client::new();
        let c = ctx(&db, &settings, &[], &http);
        // 会话绑定 p1，参数给 p1 → 成功
        let ok = resolve_paper(&c, &json!({ "paper_id": "p1" })).unwrap();
        assert_eq!(ok, "p1");
        // 无参数且无绑定 → 报错
        let c2 = ToolCtx {
            paper_id: None,
            ..c
        };
        assert!(resolve_paper(&c2, &json!({})).is_err());
    }

    #[tokio::test]
    async fn read_selection_numbers_and_cites() {
        let conn = setup_db();
        let db = Db::from_connection(conn);
        let settings = Settings::default();
        let http = reqwest::Client::new();
        let sel = [
            SelectionInput {
                text: "记忆系统通过显式存储层保存信息。".into(),
                page_idx: Some(2),
            },
            SelectionInput {
                text: "检索增强生成（RAG）结合外部知识库。".into(),
                page_idx: Some(5),
            },
        ];
        let c = ctx(&db, &settings, &sel, &http);
        let out = execute_tool(ToolKind::ReadSelection, &c, &json!({ "index": 1 }), 2).await.unwrap();
        assert_eq!(out.citations.len(), 1);
        assert_eq!(out.citations[0].index, 3); // offset 2 → 编号 3
        assert_eq!(out.citations[0].page_idx, Some(5));
        assert!(out.text.contains("[3]"));
        assert!(out.text.contains("第 6 页"));
        // 越界报错
        assert!(execute_tool(ToolKind::ReadSelection, &c, &json!({ "index": 9 }), 0).await.is_err());
    }

    #[tokio::test]
    async fn get_paper_meta_returns_metadata() {
        let conn = setup_db();
        let db = Db::from_connection(conn);
        let settings = Settings::default();
        let http = reqwest::Client::new();
        let c = ctx(&db, &settings, &[], &http);
        let out = execute_tool(ToolKind::GetPaperMeta, &c, &json!({}), 0).await.unwrap();
        assert!(out.text.contains("测试论文"));
        assert!(out.text.contains("摘要文本"));
        // 不存在的论文报错
        let err = execute_tool(ToolKind::GetPaperMeta, &c, &json!({ "paper_id": "nope" }), 0)
            .await
            .unwrap_err();
        assert!(err.contains("不存在"));
    }

    #[test]
    fn web_fetch_text_extraction_covers_html_markdown_cases() {
        // 新提取器（html_extract）覆盖原 html_to_markdown 的场景（工具内联使用）
        let html = r#"
            <html><head><style>.x{}</style></head>
            <body>
              <nav>导航</nav>
              <h1>标题一</h1>
              <p>第一段 <a href="https://example.com/a">链接A</a> 结尾。</p>
              <ul><li>项目一</li><li>项目二</li></ul>
              <script>var x = 1;</script>
            </body></html>
        "#;
        let mut ex = crate::agent::html_extract::HtmlExtractor::new(100_000);
        ex.feed(html.as_bytes());
        let md = ex.finish();
        assert!(md.contains("# 标题一"));
        assert!(md.contains("第一段"));
        assert!(md.contains("[链接A](https://example.com/a)"));
        assert!(md.contains("- 项目一"));
        assert!(!md.contains("var x"));
        assert!(!md.contains("导航"));
    }
}
