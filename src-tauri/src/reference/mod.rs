//! Zotero BibTeX / RIS 文献题录导入。
//!
//! 流程：解析 → 附件匹配 → 去重预览 → 可选 DOI 补全 → 用户确认 → 合并/新建。

use crate::db::Db;
use crate::settings::Settings;
use model::{
    ReferenceImportDecision, ReferenceImportPreview, ReferenceImportProgress,
    ReferenceImportResult,
};
use std::path::Path;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::Manager;

pub mod attachment;
pub mod bibtex;
pub mod cache;
pub mod dedupe;
pub mod import;
pub mod model;
pub mod ris;

/// 解析题录文件、匹配附件和现有论文，返回只读预览（不写库）。
#[tauri::command]
pub async fn prepare_reference_import(
    app: tauri::AppHandle,
    source_path: String,
    attachments_root: Option<String>,
    on_event: Channel<ReferenceImportProgress>,
) -> Result<ReferenceImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let mut progress = |event| {
            let _ = on_event.send(event);
        };
        let (preview, existing) = import::prepare(
            &db,
            Path::new(&source_path),
            attachments_root.as_deref().map(Path::new),
            &mut progress,
        )?;
        let (_, preview) = cache::insert(cache::PreparedImport {
            preview,
            existing,
            created_at: Instant::now(),
        });
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 对选中的预览条目做 DOI/元数据补全；只更新内存预览，不写库。
#[tauri::command]
pub async fn enrich_reference_import(
    import_id: String,
    item_ids: Vec<String>,
    on_event: Channel<ReferenceImportProgress>,
) -> Result<ReferenceImportPreview, String> {
    let mut prepared = cache::get(&import_id).ok_or("导入预览已过期，请重新选择文件")?;
    let cache_dir = crate::settings::app_data_dir()
        .map_err(|e| e.to_string())?
        .join("doi-cache");
    let mut progress = |event| {
        let _ = on_event.send(event);
    };
    let preview = import::enrich(&mut prepared, item_ids, &cache_dir, &mut progress).await?;
    cache::update(preview.clone());
    Ok(preview)
}

/// 用户确认后执行合并/新建；预览缓存消费后不可重复提交。
#[tauri::command]
pub fn commit_reference_import(
    db: tauri::State<'_, Db>,
    import_id: String,
    decisions: Vec<ReferenceImportDecision>,
    target_folder_id: Option<String>,
    allow_metadata_only: bool,
    auto_parse: bool,
) -> Result<ReferenceImportResult, String> {
    let prepared = cache::take(&import_id).ok_or("导入预览已过期，请重新选择文件")?;
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let library = settings.papers_dir().map_err(|e| e.to_string())?;
    let mut progress = |_event: ReferenceImportProgress| {};
    Ok(import::commit(
        &db,
        &library,
        &prepared,
        &decisions,
        target_folder_id.as_deref(),
        allow_metadata_only,
        auto_parse,
        &mut progress,
    ))
}

/// 给“仅导入题录”的论文补挂/替换 PDF。
#[tauri::command]
pub fn attach_paper_pdf(
    db: tauri::State<'_, Db>,
    paper_id: String,
    source_path: String,
    replace: bool,
) -> Result<crate::db::models::Paper, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let library = settings.papers_dir().map_err(|e| e.to_string())?;
    import::attach_pdf(
        &db,
        &library,
        &paper_id,
        Path::new(&source_path),
        replace,
        settings.workflow.auto_parse,
    )?;
    crate::commands::get_paper_inner(&db, &paper_id)
}
