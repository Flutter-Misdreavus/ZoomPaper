//! 文献题录导入的归一化模型（Zotero BibTeX / RIS）。

use serde::{Deserialize, Serialize};

/// 支持的题录格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceFormat {
    Bibtex,
    Ris,
}

impl ReferenceFormat {
    pub fn label(self) -> &'static str {
        match self {
            Self::Bibtex => "BibTeX",
            Self::Ris => "RIS",
        }
    }
}

/// 一条解析后的题录。只保留能映射到 ZoomPaper 论文元数据的字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceRecord {
    /// BibTeX citation key；RIS 记录使用 `ris-{序号}`。
    pub key: String,
    /// 归一化类型：journalArticle / conferencePaper / book / thesis / report / preprint / misc。
    pub item_type: String,
    pub title: String,
    /// 展示用作者名（首次出现顺序，去重）。
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub abstract_text: Option<String>,
    /// Zotero `file` / RIS `L1/L2` 中的附件路径候选（原始字符串，解析阶段不访问文件系统）。
    pub attachment_paths: Vec<String>,
}

impl ReferenceRecord {
    pub fn authors_display(&self) -> Option<String> {
        (!self.authors.is_empty()).then(|| self.authors.join(", "))
    }
}

/// 单条解析错误；不阻塞同文件其他条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceParseError {
    pub index: usize,
    pub key: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct ParseOutput {
    pub records: Vec<ReferenceRecord>,
    pub errors: Vec<ReferenceParseError>,
}

/// 一次附件匹配结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentPreview {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// 匹配来源：explicit / filename / manual。
    pub matched_by: String,
}

/// 现有论文候选（合并预览用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExistingMatch {
    pub paper_id: String,
    pub title: String,
    pub doi: Option<String>,
    pub year: Option<i64>,
    pub has_pdf: bool,
    /// doi / hash / title。
    pub reason: String,
    /// 0-100。
    pub confidence: u8,
}

/// 导入决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportAction {
    Merge,
    New,
    Skip,
}

/// 预览中的一条题录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferencePreviewItem {
    /// 前端稳定 id（`ref-{index}`）。
    pub id: String,
    pub record: ReferenceRecord,
    pub attachment: Option<AttachmentPreview>,
    /// 同名/多路径候选，供用户手动选择。
    pub attachment_candidates: Vec<String>,
    pub existing: Option<ExistingMatch>,
    /// 同一批文件中被判定为重复的其他条目 id。
    pub batch_duplicates: Vec<String>,
    pub default_action: ImportAction,
    /// 需要用户注意的说明（如多个同名 PDF、DOI 冲突）。
    pub issue: Option<String>,
    /// DOI 补全失败/低置信度的说明；None 表示未尝试或成功。
    pub enrichment_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceImportPreview {
    pub import_id: String,
    pub format: ReferenceFormat,
    pub total: usize,
    pub items: Vec<ReferencePreviewItem>,
    pub errors: Vec<ReferenceParseError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceImportDecision {
    pub item_id: String,
    pub action: ImportAction,
    /// merge 时必须提供；new/skip 忽略。
    pub paper_id: Option<String>,
    /// 用户手动选择的 PDF；覆盖自动匹配。
    pub attachment_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceImportFailure {
    pub item_id: String,
    pub title: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceImportResult {
    pub created: usize,
    pub merged: usize,
    pub skipped: usize,
    pub failed: usize,
    pub warnings: Vec<String>,
    pub failures: Vec<ReferenceImportFailure>,
    pub paper_ids: Vec<String>,
}

/// 导入/补全/提交进度（Tauri Channel）。
#[derive(Debug, Clone, Serialize)]
pub struct ReferenceImportProgress {
    /// parsing / indexing / matching / hashing / enriching / importing / done
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub message: String,
}
