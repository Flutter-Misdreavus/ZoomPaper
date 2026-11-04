//! Zotero 导入的预览、DOI 补全、合并/新建与 PDF 补挂。

use super::attachment::{
    self, is_pdf_file, sha256_file, AttachmentIndex, MAX_IMPORT_PDF_BYTES,
};
use super::bibtex;
use super::cache::PreparedImport;
use super::dedupe::{self, ExistingPaper};
use super::model::{
    AttachmentPreview, ImportAction, ReferenceFormat, ReferenceImportDecision,
    ReferenceImportFailure, ReferenceImportPreview, ReferenceImportProgress,
    ReferenceImportResult, ReferencePreviewItem, ReferenceRecord,
};
use super::ris;
use crate::db::Db;
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn prepare(
    db: &Db,
    source_path: &Path,
    attachments_root: Option<&Path>,
    progress: &mut dyn FnMut(ReferenceImportProgress),
) -> Result<(ReferenceImportPreview, Vec<ExistingPaper>), String> {
    let content = attachment::read_reference_file(source_path)?;
    let format = attachment::detect_format(source_path, &content)?;
    progress(ReferenceImportProgress {
        phase: "parsing".into(),
        completed: 0,
        total: 1,
        message: format!("正在解析 {}…", format.label()),
    });
    let parsed = match format {
        ReferenceFormat::Bibtex => bibtex::parse(&content),
        ReferenceFormat::Ris => ris::parse(&content),
    };
    if parsed.records.is_empty() {
        let detail = parsed
            .errors
            .first()
            .map(|error| format!("：{}", error.message))
            .unwrap_or_default();
        return Err(format!("没有解析到有效题录{detail}"));
    }
    let source_dir = source_path.parent().unwrap_or_else(|| Path::new("."));
    let index = match attachments_root {
        Some(root) => AttachmentIndex::build(root, source_dir)?,
        None => AttachmentIndex::empty(source_dir),
    };
    progress(ReferenceImportProgress {
        phase: "matching".into(),
        completed: 0,
        total: parsed.records.len(),
        message: "正在匹配 PDF 附件…".into(),
    });
    let existing = load_existing(db)?;
    let groups = batch_groups(&parsed.records);
    let mut items = Vec::with_capacity(groups.len());
    let mut hash_cache: HashMap<PathBuf, String> = HashMap::new();
    for (group_index, group) in groups.iter().enumerate() {
        let mut record = parsed.records[group[0]].clone();
        let mut batch_duplicates = Vec::new();
        for other in &group[1..] {
            batch_duplicates.push(format!("ref-{other}"));
            merge_record_missing(&mut record, &parsed.records[*other]);
        }
        let mut candidate_paths = Vec::new();
        for raw in &record.attachment_paths {
            for path in index.candidates(raw) {
                if !candidate_paths.iter().any(|existing| existing == &path) {
                    candidate_paths.push(path);
                }
            }
        }
        if candidate_paths.is_empty() {
            // 标准 Zotero BibTeX/RIS 可能不带 file/L1；用标题/citation key 在附件根目录中回退。
            candidate_paths.extend(index.find_by_title(&record.title, &record.key));
        }
        candidate_paths.retain(|path| is_pdf_file(path));
        let mut issue = None;
        let attachment = if candidate_paths.len() == 1 {
            let path = candidate_paths.remove(0);
            let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            Some(AttachmentPreview {
                path: path.to_string_lossy().into_owned(),
                file_name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size: metadata.len(),
                matched_by: "auto".to_string(),
            })
        } else {
            if candidate_paths.len() > 1 {
                issue = Some("找到多个同名 PDF，请手动选择".to_string());
            } else {
                issue = Some("未匹配到 PDF 附件".to_string());
            }
            None
        };
        let pdf_hash = if let Some(attachment) = attachment.as_ref() {
            let path = PathBuf::from(&attachment.path);
            if let Some(hash) = hash_cache.get(&path) {
                Some(hash.clone())
            } else {
                progress(ReferenceImportProgress {
                    phase: "hashing".into(),
                    completed: group_index,
                    total: groups.len(),
                    message: format!("正在校验附件 {}", attachment.file_name),
                });
                let hash = sha256_file(&path)?;
                hash_cache.insert(path, hash.clone());
                Some(hash)
            }
        } else {
            None
        };
        let existing_match = dedupe::best_match(&record, pdf_hash.as_deref(), &existing);
        let mut default_action = ImportAction::New;
        if let Some(existing) = &existing_match {
            default_action = if existing.confidence >= 95 {
                ImportAction::Merge
            } else {
                ImportAction::Skip
            };
            if existing.confidence < 95 {
                issue = Some(match issue {
                    Some(issue) => format!("{issue}；疑似重复：{}", existing.title),
                    None => format!("疑似重复：{}", existing.title),
                });
            }
        } else if attachment.is_none() {
            default_action = ImportAction::Skip;
        }
        let id = format!("ref-{}", group[0]);
        items.push(ReferencePreviewItem {
            id,
            record,
            attachment,
            attachment_candidates: candidate_paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            existing: existing_match,
            batch_duplicates,
            default_action,
            issue,
            enrichment_error: None,
        });
        progress(ReferenceImportProgress {
            phase: "matching".into(),
            completed: group_index + 1,
            total: groups.len(),
            message: format!("已匹配 {} 条题录", group_index + 1),
        });
    }
    Ok((
        ReferenceImportPreview {
            import_id: String::new(),
            format,
            total: items.len(),
            items,
            errors: parsed.errors,
        },
        existing,
    ))
}

fn batch_groups(records: &[ReferenceRecord]) -> Vec<Vec<usize>> {
    let mut keys: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let key = if record.title.trim().chars().count() >= 4 {
            format!(
                "title:{}|{}",
                dedupe::normalized_title(&record.title),
                record.year.map(|year| year.to_string()).unwrap_or_default()
            )
        } else if let Some(doi) = record.doi.as_deref() {
            format!("doi:{doi}")
        } else {
            format!("key:{index}")
        };
        if let Some(group) = keys.get(&key) {
            groups[*group].push(index);
        } else {
            keys.insert(key, groups.len());
            groups.push(vec![index]);
        }
    }
    groups
}

fn merge_record_missing(base: &mut ReferenceRecord, other: &ReferenceRecord) {
    if base.title.trim().is_empty() {
        base.title = other.title.clone();
    }
    if base.year.is_none() {
        base.year = other.year;
    }
    if base.venue.is_none() {
        base.venue = other.venue.clone();
    }
    if base.doi.is_none() {
        base.doi = other.doi.clone();
    }
    if base.url.is_none() {
        base.url = other.url.clone();
    }
    if base.abstract_text.is_none() {
        base.abstract_text = other.abstract_text.clone();
    }
    for author in &other.authors {
        if !base.authors.iter().any(|existing| existing == author) {
            base.authors.push(author.clone());
        }
    }
    for path in &other.attachment_paths {
        if !base.attachment_paths.iter().any(|existing| existing == path) {
            base.attachment_paths.push(path.clone());
        }
    }
}

pub fn load_existing(db: &Db) -> Result<Vec<ExistingPaper>, String> {
    let rows: Vec<(String, String, Option<String>, Option<i64>, Option<String>, Option<String>, String, String)> = {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id,title,doi,year,authors,content_hash,pdf_path,md_path \
                 FROM papers WHERE deleted_at IS NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let mut result = Vec::with_capacity(rows.len());
    for (id, title, mut doi, mut year, authors, content_hash, pdf_path, md_path) in rows {
        if doi.is_none() || year.is_none() {
            if let Some(dir) = Path::new(&md_path).parent() {
                if let Ok(bytes) = std::fs::read(dir.join("publication.json")) {
                    if let Ok(record) =
                        serde_json::from_slice::<crate::publication::Publication>(&bytes)
                    {
                        if doi.is_none() {
                            doi = Some(record.doi);
                        }
                        if year.is_none() {
                            year = record.year;
                        }
                    }
                }
            }
        }
        result.push(ExistingPaper {
            id,
            title,
            doi: doi.and_then(|doi| crate::publication::normalize_doi(&doi)),
            year,
            authors,
            has_pdf: !pdf_path.trim().is_empty() && Path::new(&pdf_path).is_file(),
            content_hash,
        });
    }
    Ok(result)
}

pub async fn enrich(
    prepared: &mut PreparedImport,
    item_ids: Vec<String>,
    cache_dir: &Path,
    progress: &mut (dyn FnMut(ReferenceImportProgress) + Send),
) -> Result<ReferenceImportPreview, String> {
    let total = item_ids.len();
    let existing_papers = prepared.existing.clone();
    for (completed, id) in item_ids.iter().enumerate() {
        progress(ReferenceImportProgress {
            phase: "enriching".into(),
            completed,
            total,
            message: "正在补全 DOI/元数据…".into(),
        });
        let Some(item_index) = prepared
            .preview
            .items
            .iter()
            .position(|item| &item.id == id)
        else {
            continue;
        };
        let mut record = prepared.preview.items[item_index].record.clone();
        let result = enrich_record(&mut record, cache_dir).await;
        let item = &mut prepared.preview.items[item_index];
        match result {
            Ok(Some(publication)) => {
                apply_publication(&mut record, &publication);
                item.record = record;
                item.enrichment_error = None;
            }
            Ok(None) => {
                item.enrichment_error = Some("未找到高置信度的 DOI 结果".into());
            }
            Err(error) => item.enrichment_error = Some(error),
        }
        // DOI 补全后重新评估一次现有论文匹配（PDF 哈希此处未知，标题/DOI 足够）。
        if let Some(existing) = dedupe::best_match(&item.record, None, &existing_papers) {
            if existing.confidence >= 95 {
                item.default_action = ImportAction::Merge;
            }
            item.existing = Some(existing);
        }
    }
    progress(ReferenceImportProgress {
        phase: "enriching".into(),
        completed: total,
        total,
        message: "DOI 补全完成".into(),
    });
    Ok(prepared.preview.clone())
}

async fn enrich_record(
    record: &mut ReferenceRecord,
    cache_dir: &Path,
) -> Result<Option<crate::publication::Publication>, String> {
    if let Some(doi) = record.doi.as_deref() {
        let publication = crate::publication::lookup(doi, cache_dir).await?;
        if let Some(publication) = publication {
            if crate::publication::title_matches(&record.title, &publication.title) {
                return Ok(Some(publication));
            }
            return Err("DOI 元数据标题与题录标题不一致，已跳过".into());
        }
        return Ok(None);
    }
    let authors = record.authors_display();
    crate::publication::search_by_title(
        &record.title,
        authors.as_deref(),
        record.year,
        cache_dir,
    )
    .await
}

fn apply_publication(record: &mut ReferenceRecord, publication: &crate::publication::Publication) {
    if record.doi.is_none() {
        record.doi = crate::publication::normalize_doi(&publication.doi);
    }
    if record.year.is_none() {
        record.year = publication.year;
    }
    if record.venue.is_none() {
        record.venue = publication.venue.clone();
    }
    if record.authors.is_empty() {
        if let Some(authors) = publication.authors.as_deref() {
            record.authors = authors
                .split(',')
                .map(str::trim)
                .filter(|author| !author.is_empty())
                .map(str::to_string)
                .collect();
        }
    }
    if record.abstract_text.is_none() {
        record.abstract_text = publication.abstract_text.clone();
    }
}

pub fn commit(
    db: &Db,
    library: &Path,
    prepared: &PreparedImport,
    decisions: &[ReferenceImportDecision],
    target_folder_id: Option<&str>,
    allow_metadata_only: bool,
    auto_parse: bool,
    progress: &mut dyn FnMut(ReferenceImportProgress),
) -> ReferenceImportResult {
    let mut result = ReferenceImportResult {
        created: 0,
        merged: 0,
        skipped: 0,
        failed: 0,
        warnings: Vec::new(),
        failures: Vec::new(),
        paper_ids: Vec::new(),
    };
    if let Some(folder_id) = target_folder_id {
        if !folder_exists(db, folder_id) {
            result.warnings.push("目标文件夹不存在，已跳过文件夹归属".into());
        }
    }
    let decision_map: HashMap<&str, &ReferenceImportDecision> = decisions
        .iter()
        .map(|decision| (decision.item_id.as_str(), decision))
        .collect();
    let total = prepared.preview.items.len();
    for (index, item) in prepared.preview.items.iter().enumerate() {
        progress(ReferenceImportProgress {
            phase: "importing".into(),
            completed: index,
            total,
            message: format!("正在导入：{}", item.record.title),
        });
        let decision = decision_map.get(item.id.as_str());
        let action = decision
            .map(|decision| decision.action)
            .unwrap_or(item.default_action);
        if action == ImportAction::Skip {
            result.skipped += 1;
            continue;
        }
        let attachment_path = decision
            .and_then(|decision| decision.attachment_path.as_deref())
            .map(PathBuf::from)
            .or_else(|| item.attachment.as_ref().map(|attachment| PathBuf::from(&attachment.path)));
        if let Some(path) = attachment_path.as_deref() {
            if !is_pdf_file(path) {
                result.failed += 1;
                result.failures.push(ReferenceImportFailure {
                    item_id: item.id.clone(),
                    title: item.record.title.clone(),
                    error: "附件不是有效 PDF 或文件不存在".into(),
                });
                continue;
            }
        }
        if action == ImportAction::New && attachment_path.is_none() && !allow_metadata_only {
            result.failed += 1;
            result.failures.push(ReferenceImportFailure {
                item_id: item.id.clone(),
                title: item.record.title.clone(),
                error: "没有 PDF 且未允许仅导入题录".into(),
            });
            continue;
        }
        let outcome = match action {
            ImportAction::Merge => {
                let paper_id = decision
                    .and_then(|decision| decision.paper_id.as_deref())
                    .or_else(|| item.existing.as_ref().map(|existing| existing.paper_id.as_str()));
                match paper_id {
                    Some(paper_id) => merge_existing(
                        db,
                        library,
                        paper_id,
                        &item.record,
                        attachment_path.as_deref(),
                        target_folder_id,
                        auto_parse,
                        &mut result.warnings,
                    ),
                    None => Err("合并目标论文不存在".to_string()),
                }
            }
            ImportAction::New => create_new(
                db,
                library,
                &item.record,
                attachment_path.as_deref(),
                target_folder_id,
                auto_parse,
                &mut result.warnings,
            ),
            ImportAction::Skip => unreachable!(),
        };
        match outcome {
            Ok(paper_id) => {
                if action == ImportAction::Merge {
                    result.merged += 1;
                } else {
                    result.created += 1;
                }
                result.paper_ids.push(paper_id);
            }
            Err(error) => {
                result.failed += 1;
                result.failures.push(ReferenceImportFailure {
                    item_id: item.id.clone(),
                    title: item.record.title.clone(),
                    error,
                });
            }
        }
    }
    progress(ReferenceImportProgress {
        phase: "done".into(),
        completed: total,
        total,
        message: "导入完成".into(),
    });
    result
}

fn folder_exists(db: &Db, folder_id: &str) -> bool {
    db.conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1)",
            [folder_id],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false)
}

fn add_to_folder(db: &Db, paper_id: &str, folder_id: Option<&str>) {
    let Some(folder_id) = folder_id else {
        return;
    };
    let now = chrono::Utc::now().timestamp();
    let _ = db.conn().execute(
        "INSERT OR IGNORE INTO paper_folders (paper_id, folder_id, created_at) VALUES (?1, ?2, ?3)",
        params![paper_id, folder_id, now],
    );
}

struct ExistingPaperRow {
    title: String,
    doi: Option<String>,
    year: Option<i64>,
    venue: Option<String>,
    authors: Option<String>,
    abstract_text: Option<String>,
    source_url: Option<String>,
    pdf_path: String,
    md_path: String,
    content_hash: Option<String>,
}

fn read_paper_row(db: &Db, paper_id: &str) -> Result<ExistingPaperRow, String> {
    db.conn()
        .query_row(
            "SELECT title,doi,year,venue,authors,abstract,source_url,pdf_path,md_path,content_hash \
             FROM papers WHERE id=?1 AND deleted_at IS NULL",
            [paper_id],
            |row| {
                Ok(ExistingPaperRow {
                    title: row.get(0)?,
                    doi: row.get(1)?,
                    year: row.get(2)?,
                    venue: row.get(3)?,
                    authors: row.get(4)?,
                    abstract_text: row.get(5)?,
                    source_url: row.get(6)?,
                    pdf_path: row.get(7)?,
                    md_path: row.get(8)?,
                    content_hash: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "论文不存在或已在回收站".to_string())
}

fn merge_existing(
    db: &Db,
    library: &Path,
    paper_id: &str,
    record: &ReferenceRecord,
    attachment_path: Option<&Path>,
    target_folder_id: Option<&str>,
    auto_parse: bool,
    warnings: &mut Vec<String>,
) -> Result<String, String> {
    let existing = read_paper_row(db, paper_id)?;
    let mut doi_conflict = false;
    if let (Some(current), Some(incoming)) = (existing.doi.as_deref(), record.doi.as_deref()) {
        if !current.eq_ignore_ascii_case(incoming) {
            doi_conflict = true;
            warnings.push(format!(
                "《{}》已有 DOI {current}，导入题录 DOI {incoming} 未覆盖",
                existing.title
            ));
        }
    }
    let has_pdf = !existing.pdf_path.trim().is_empty() && Path::new(&existing.pdf_path).is_file();
    let doi = existing.doi.clone().or_else(|| record.doi.clone());
    let year = existing.year.or(record.year);
    let venue = existing.venue.clone().or(record.venue.clone());
    let authors = existing.authors.clone().or_else(|| record.authors_display());
    let abstract_text = existing
        .abstract_text
        .clone()
        .or_else(|| record.abstract_text.clone());
    let source_url = existing
        .source_url
        .clone()
        .or_else(|| {
            record
                .url
                .as_deref()
                .and_then(normalize_source_url)
        });
    let mut attached_hash = None;
    let mut attached = false;
    if !has_pdf {
        if let Some(source) = attachment_path {
            let dir = crate::fs::ensure_paper_dir(library, paper_id).map_err(|e| e.to_string())?;
            let dest = dir.join("paper.pdf");
            std::fs::copy(source, &dest).map_err(|e| format!("复制 PDF 失败：{e}"))?;
            attached_hash = Some(sha256_file(&dest)?);
            attached = true;
        }
    } else if let Some(source) = attachment_path {
        if let Ok(incoming_hash) = sha256_file(source) {
            if existing.content_hash.as_deref() != Some(incoming_hash.as_str()) {
                warnings.push(format!("《{}》已有 PDF，未替换导入附件", existing.title));
            }
        }
    }
    {
        let conn = db.conn();
        conn.execute(
            "UPDATE papers SET \
               doi = COALESCE(NULLIF(trim(doi), ''), ?2), \
               year = COALESCE(year, ?3), \
               venue = COALESCE(NULLIF(trim(venue), ''), ?4), \
               authors = CASE WHEN authors IS NULL OR trim(authors) = '' OR authors = '[]' THEN ?5 ELSE authors END, \
               abstract = CASE WHEN abstract IS NULL OR trim(abstract) = '' THEN ?6 ELSE abstract END, \
               source_url = COALESCE(NULLIF(trim(source_url), ''), ?7), \
               pdf_path = CASE WHEN ?8 THEN ?9 ELSE pdf_path END, \
               content_hash = CASE WHEN ?8 THEN ?10 ELSE content_hash END, \
               parse_status = CASE WHEN ?8 THEN 'unparsed' ELSE parse_status END \
             WHERE id = ?1",
            params![
                paper_id,
                doi,
                year,
                venue,
                authors,
                abstract_text,
                source_url,
                attached,
                if attached {
                    Path::new(&existing.md_path)
                        .parent()
                        .map(|dir| dir.join("paper.pdf").to_string_lossy().into_owned())
                        .unwrap_or_default()
                } else {
                    existing.pdf_path.clone()
                },
                attached_hash,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    add_to_folder(db, paper_id, target_folder_id);
    if record.doi.is_some() && !doi_conflict {
        write_doi_files(
            Path::new(&existing.md_path)
                .parent()
                .unwrap_or_else(|| Path::new(".")),
            record,
        );
    }
    if attached && auto_parse {
        let _ = crate::jobs::enqueue(db, paper_id, "parse");
    }
    Ok(paper_id.to_string())
}

fn create_new(
    db: &Db,
    library: &Path,
    record: &ReferenceRecord,
    attachment_path: Option<&Path>,
    target_folder_id: Option<&str>,
    auto_parse: bool,
    warnings: &mut Vec<String>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = crate::fs::ensure_paper_dir(library, &id).map_err(|e| e.to_string())?;
    let dest = dir.join("paper.pdf");
    let mut content_hash = None;
    let mut has_pdf = false;
    if let Some(source) = attachment_path {
        if let Err(error) = std::fs::copy(source, &dest) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("复制 PDF 失败：{error}"));
        }
        content_hash = match sha256_file(&dest) {
            Ok(hash) => Some(hash),
            Err(error) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(error);
            }
        };
        has_pdf = true;
    }
    let md_path = dir.join("paper.md");
    let now = chrono::Utc::now().timestamp();
    let title = record
        .title
        .trim()
        .chars()
        .take(300)
        .collect::<String>();
    let venue = record.venue.as_deref().and_then(crate::commands::normalize_venue);
    let source_url = record.url.as_deref().and_then(normalize_source_url);
    let authors = record.authors_display();
    let insert = (|| -> Result<(), String> {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO papers \
             (id,title,authors,abstract,pdf_path,md_path,created_at,reading_status,parse_status, \
              source_url,venue,doi,year,content_hash) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,'unread','unparsed',?8,?9,?10,?11,?12)",
            params![
                &id,
                &title,
                authors,
                record.abstract_text.clone(),
                if has_pdf { dest.to_string_lossy().into_owned() } else { String::new() },
                md_path.to_string_lossy().into_owned(),
                now,
                source_url,
                venue,
                record.doi.clone(),
                record.year,
                content_hash,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = insert {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    write_doi_files(&dir, record);
    add_to_folder(db, &id, target_folder_id);
    if has_pdf && auto_parse {
        if let Err(error) = crate::jobs::enqueue(db, &id, "parse") {
            warnings.push(format!("《{title}》已导入，但解析任务入队失败：{error}"));
        }
    }
    Ok(id)
}

fn write_doi_files(dir: &Path, record: &ReferenceRecord) {
    let Some(doi) = record.doi.as_deref() else {
        return;
    };
    let _ = std::fs::write(dir.join("doi-hint.json"), serde_json::to_vec(&doi).unwrap());
    let publication_path = dir.join("publication.json");
    if publication_path.exists() {
        return;
    }
    let publication = crate::publication::Publication {
        doi: doi.to_string(),
        title: record.title.clone(),
        venue: record.venue.clone(),
        authors: record.authors_display(),
        year: record.year,
        abstract_text: record.abstract_text.clone(),
    };
    let _ = std::fs::write(
        publication_path,
        serde_json::to_vec(&publication).unwrap(),
    );
}

fn normalize_source_url(raw: &str) -> Option<String> {
    reqwest::Url::parse(raw.trim())
        .ok()
        .filter(|url| url.scheme() == "https")
        .map(|url| url.to_string())
}

pub fn attach_pdf(
    db: &Db,
    library: &Path,
    paper_id: &str,
    source: &Path,
    replace: bool,
    auto_parse: bool,
) -> Result<(), String> {
    if !is_pdf_file(source) {
        return Err("选择的文件不是有效 PDF（或超过 100 MB）".to_string());
    }
    let row = read_paper_row(db, paper_id)?;
    let has_pdf = !row.pdf_path.trim().is_empty() && Path::new(&row.pdf_path).is_file();
    if has_pdf && !replace {
        return Err("这篇论文已有 PDF；如需替换请确认替换操作".to_string());
    }
    let metadata = std::fs::metadata(source).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_IMPORT_PDF_BYTES {
        return Err("PDF 超过 100 MB，已停止导入".to_string());
    }
    let hash = sha256_file(source)?;
    let duplicate: Option<String> = db
        .conn()
        .query_row(
            "SELECT title FROM papers WHERE content_hash=?1 AND id<>?2 AND deleted_at IS NULL LIMIT 1",
            params![&hash, paper_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(title) = duplicate {
        return Err(format!("这篇 PDF 已存在于论文库：{title}"));
    }
    let dir = crate::fs::ensure_paper_dir(library, paper_id).map_err(|e| e.to_string())?;
    let dest = dir.join("paper.pdf");
    std::fs::copy(source, &dest).map_err(|e| format!("复制 PDF 失败：{e}"))?;
    db.conn()
        .execute(
            "UPDATE papers SET pdf_path=?2,content_hash=?3,parse_status='unparsed' WHERE id=?1",
            params![paper_id, dest.to_string_lossy().into_owned(), hash],
        )
        .map_err(|e| e.to_string())?;
    if auto_parse {
        let _ = crate::jobs::enqueue(db, paper_id, "parse");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::time::Instant;

    fn setup() -> (Db, PathBuf) {
        db::register_sqlite_vec();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::migrations::migrate(&conn).unwrap();
        let db = Db::from_connection(conn);
        let root = std::env::temp_dir().join(format!("zoom-ref-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        (db, root)
    }

    #[test]
    fn batch_groups_by_doi_and_title() {
        let mut a = record("A Paper", Some("10.1/abc"), Some(2020));
        let mut b = record("A Paper", Some("10.1/abc"), Some(2020));
        let c = record("A Paper", None, Some(2020));
        let groups = batch_groups(&[a.clone(), b.clone(), c]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].len(), 3);
        a.title = "Other".into();
        b.title = "Other".into();
        assert_eq!(batch_groups(&[a, b]).len(), 1);
    }

    #[test]
    fn create_new_metadata_only_creates_empty_pdf_path() {
        let (db_, root) = setup();
        let library = root.join("papers");
        std::fs::create_dir_all(&library).unwrap();
        let mut warnings = vec![];
        let id = create_new(
            &db_,
            &library,
            &record("Test Paper", None, Some(2024)),
            None,
            None,
            false,
            &mut warnings,
        )
        .unwrap();
        let (pdf, status): (String, String) = db_
            .conn()
            .query_row("SELECT pdf_path,parse_status FROM papers WHERE id=?1", [&id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert!(pdf.is_empty());
        assert_eq!(status, "unparsed");
        assert!(root.join(&library).exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn merge_keeps_existing_annotations_folders_and_pdf() {
        let (db_, root) = setup();
        let library = root.join("papers");
        let paper_dir = library.join("existing");
        std::fs::create_dir_all(&paper_dir).unwrap();
        let existing_pdf = paper_dir.join("paper.pdf");
        std::fs::write(&existing_pdf, b"%PDF-existing").unwrap();
        let annotations = paper_dir.join("annotations.json");
        std::fs::write(&annotations, r#"{"version":1,"highlights":["keep"]}"#).unwrap();
        db_.conn()
            .execute(
                "INSERT INTO papers(id,title,authors,abstract,pdf_path,md_path,doi,year,content_hash) \
                 VALUES('existing','Existing Paper','Smith, John','Old',?1,?2,'10.1145/abc',2020,'oldhash')",
                params![
                    existing_pdf.to_string_lossy().into_owned(),
                    paper_dir.join("paper.md").to_string_lossy().into_owned()
                ],
            )
            .unwrap();
        db_.conn()
            .execute("INSERT INTO folders(id,name,color,tags,created_at) VALUES('f1','Old','gray','[]',1),('f2','Target','gray','[]',1)", [])
            .unwrap();
        db_.conn()
            .execute("INSERT INTO paper_folders(paper_id,folder_id,created_at) VALUES('existing','f1',1)", [])
            .unwrap();
        let attachment = root.join("attachments/other.pdf");
        std::fs::create_dir_all(attachment.parent().unwrap()).unwrap();
        std::fs::write(&attachment, b"%PDF-other").unwrap();
        let source = root.join("refs.bib");
        std::fs::write(
            &source,
            format!(
                "@article{{existing, title={{Existing Paper}}, author={{Smith, John}}, year={{2020}}, doi={{10.1145/ABC}}, file={{Full Text:{}}}}}",
                attachment.to_string_lossy()
            ),
        )
        .unwrap();
        let (preview, existing) = prepare(&db_, &source, Some(&root), &mut |_| {}).unwrap();
        assert_eq!(preview.items.len(), 1);
        assert_eq!(
            preview.items[0].existing.as_ref().unwrap().paper_id,
            "existing"
        );
        let prepared = PreparedImport {
            preview: preview.clone(),
            existing,
            created_at: Instant::now(),
        };
        let decisions = vec![ReferenceImportDecision {
            item_id: preview.items[0].id.clone(),
            action: ImportAction::Merge,
            paper_id: Some("existing".into()),
            attachment_path: Some(attachment.to_string_lossy().into_owned()),
        }];
        let result = commit(
            &db_,
            &library,
            &prepared,
            &decisions,
            Some("f2"),
            false,
            false,
            &mut |_| {},
        );
        assert_eq!(result.merged, 1);
        assert_eq!(result.created, 0);
        let (doi, year, pdf): (String, i64, String) = db_
            .conn()
            .query_row(
                "SELECT doi,year,pdf_path FROM papers WHERE id='existing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(doi, "10.1145/abc");
        assert_eq!(year, 2020);
        assert_eq!(pdf, existing_pdf.to_string_lossy());
        assert_eq!(
            std::fs::read_to_string(&annotations).unwrap(),
            r#"{"version":1,"highlights":["keep"]}"#
        );
        let folders: i64 = db_
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM paper_folders WHERE paper_id='existing' AND folder_id IN ('f1','f2')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folders, 2);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn attach_pdf_to_metadata_only_paper() {
        let (db_, root) = setup();
        let library = root.join("papers");
        std::fs::create_dir_all(&library).unwrap();
        let mut warnings = vec![];
        let id = create_new(
            &db_,
            &library,
            &record("Needs PDF", None, Some(2024)),
            None,
            None,
            false,
            &mut warnings,
        )
        .unwrap();
        let source = root.join("attach.pdf");
        std::fs::write(&source, b"%PDF-attached").unwrap();
        attach_pdf(&db_, &library, &id, &source, false, false).unwrap();
        let (pdf, status, hash): (String, String, Option<String>) = db_
            .conn()
            .query_row(
                "SELECT pdf_path,parse_status,content_hash FROM papers WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(pdf.ends_with("paper.pdf"));
        assert_eq!(status, "unparsed");
        assert!(hash.is_some());
        assert!(attach_pdf(&db_, &library, &id, &source, false, false).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn commit_allows_metadata_only_when_explicitly_enabled() {
        let (db_, root) = setup();
        let library = root.join("papers");
        std::fs::create_dir_all(&library).unwrap();
        let source = root.join("refs.ris");
        std::fs::write(
            &source,
            "TY  - JOUR\nTI  - Metadata Only Paper\nAU  - Smith, John\nPY  - 2024\nER  - \n",
        )
        .unwrap();
        let (preview, existing) = prepare(&db_, &source, None, &mut |_| {}).unwrap();
        assert!(preview.items[0].attachment.is_none());
        assert_eq!(preview.items[0].default_action, ImportAction::Skip);
        let prepared = PreparedImport {
            preview: preview.clone(),
            existing,
            created_at: Instant::now(),
        };
        let decisions = vec![ReferenceImportDecision {
            item_id: preview.items[0].id.clone(),
            action: ImportAction::New,
            paper_id: None,
            attachment_path: None,
        }];
        let result = commit(
            &db_,
            &library,
            &prepared,
            &decisions,
            None,
            true,
            false,
            &mut |_| {},
        );
        assert_eq!(result.created, 1);
        let pdf: String = db_
            .conn()
            .query_row("SELECT pdf_path FROM papers", [], |row| row.get(0))
            .unwrap();
        assert!(pdf.is_empty());
        std::fs::remove_dir_all(root).ok();
    }

    fn record(title: &str, doi: Option<&str>, year: Option<i64>) -> ReferenceRecord {
        ReferenceRecord {
            key: "key".into(),
            item_type: "journalArticle".into(),
            title: title.into(),
            authors: vec!["Smith, John".into()],
            year,
            venue: None,
            doi: doi.map(str::to_string),
            url: None,
            abstract_text: None,
            attachment_paths: vec![],
        }
    }
}
