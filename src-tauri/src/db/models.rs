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
    /// 阅读状态：unread / reading / read
    pub reading_status: String,
    /// 解析状态：unparsed / parsing / ready / failed
    pub parse_status: String,
    /// 星标（论文库工作台）
    pub starred: bool,
    /// 最近一次标记已读时间（epoch 秒）；None = 未读完/已取消已读。
    pub finished_at: Option<i64>,
    /// 累计阅读时长（秒），由 reading_sessions 聚合填充。
    pub total_read_seconds: i64,
    /// 所属文件夹 id 列表（多归属；空数组 = 未分类）。由 list/get 聚合填充。
    pub folder_ids: Vec<String>,
}

/// 阅读计划：daily = 每天读完 N 篇的持续性定量目标；
/// papers = 指派一组论文 + 截止日期的任务清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingPlan {
    pub id: String,
    #[serde(rename = "type")]
    pub plan_type: String,
    pub target_count: Option<i64>,
    /// 指派的论文 id 列表（JSON 数组解析后；daily 计划为空）。
    pub paper_ids: Vec<String>,
    pub deadline: Option<i64>,
    pub created_at: i64,
    pub active: bool,
}

/// 虚拟文件夹（多归属集合式，论文库内的整理容器；不对应磁盘目录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// 父文件夹 id；None = 顶级文件夹。
    pub parent_id: Option<String>,
    /// 色板 key（红/橙/黄/绿/蓝/紫/粉/灰/棕/青 之一）。
    pub color: String,
    /// 自由文本标签列表。
    pub tags: Vec<String>,
    pub created_at: i64,
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
    /// 费曼会话滚动「教学进展」摘要（长对话控 token；qa 会话恒为 None）。
    pub summary: Option<String>,
    /// 遗留：旧版费曼要点笔记，已弃用（保留惰性列，不再写入）。
    pub notes: Option<String>,
    /// 费曼闯关状态 JSON（概念计划 / 当前关卡 / 各概念状态）；None = 旧版自由聊天会话。
    pub feynman_state: Option<String>,
    /// 费曼「概念级独立会话」标记：NULL = 主行（或 qa / 旧版单会话）；N = 概念 N 的会话行。
    pub concept_index: Option<i64>,
}
