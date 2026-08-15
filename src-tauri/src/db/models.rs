//! 数据模型：与 SQLite 表对应的结构体。

use serde::{Deserialize, Serialize};

/// 论文表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paper {
    pub id: String,
    pub title: String,
    pub authors: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub pdf_path: String,
    pub md_path: String,
    pub blog_md_path: Option<String>,
    pub created_at: i64,
    pub last_read_at: Option<i64>,
    pub reading_status: String,
    /// 解析状态：unparsed / parsing / ready / failed
    pub parse_status: String,
}

/// 论文文本分块（RAG 检索单元）。
///
/// `start_line`/`end_line` 语义为 content_list 的块索引范围（非 md 行号）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub id: i64,
    pub paper_id: String,
    pub section: String,
    pub content: String,
    pub start_line: i64,
    pub end_line: i64,
    pub page_idx: Option<i64>,
    pub bbox: Option<String>,
}

/// 检索命中结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub paper_id: String,
    pub paper_title: String,
    pub section: String,
    pub content: String,
    pub page_idx: Option<i64>,
    pub distance: f32,
}

/// 对话记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub paper_id: Option<String>,
    #[serde(rename = "type")]
    pub conv_type: String,
    pub title: String,
    pub messages: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 费曼会话首轮生成的要点笔记（qa 会话恒为 None）。
    pub notes: Option<String>,
}
