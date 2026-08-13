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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub id: i64,
    pub paper_id: String,
    pub section: String,
    pub content: String,
    pub start_line: i64,
    pub end_line: i64,
}

/// 对话记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub paper_id: String,
    #[serde(rename = "type")]
    pub conv_type: String,
    pub title: String,
    pub messages: String,
    pub created_at: i64,
    pub updated_at: i64,
}
