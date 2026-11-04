//! 导入预览的内存缓存。预览不写库；commit 时取出并消费。

use super::dedupe::ExistingPaper;
use super::model::ReferenceImportPreview;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_IMPORTS: usize = 10;
const TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
pub struct PreparedImport {
    pub preview: ReferenceImportPreview,
    pub existing: Vec<ExistingPaper>,
    pub created_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, PreparedImport>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PreparedImport>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn purge(map: &mut HashMap<String, PreparedImport>) {
    map.retain(|_, prepared| prepared.created_at.elapsed() < TTL);
    while map.len() > MAX_IMPORTS {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, prepared)| prepared.created_at)
            .map(|(id, _)| id.clone())
        {
            map.remove(&oldest);
        } else {
            break;
        }
    }
}

pub fn insert(mut prepared: PreparedImport) -> (String, ReferenceImportPreview) {
    let id = uuid::Uuid::new_v4().to_string();
    prepared.preview.import_id = id.clone();
    let preview = prepared.preview.clone();
    let mut map = cache().lock().unwrap();
    purge(&mut map);
    map.insert(id.clone(), prepared);
    (id, preview)
}

pub fn get(id: &str) -> Option<PreparedImport> {
    let mut map = cache().lock().unwrap();
    purge(&mut map);
    map.get(id).cloned()
}

/// 更新预览（DOI 补全后回写缓存）。
pub fn update(preview: ReferenceImportPreview) -> bool {
    let mut map = cache().lock().unwrap();
    let Some(prepared) = map.get_mut(&preview.import_id) else {
        return false;
    };
    prepared.preview = preview;
    true
}

/// commit 时消费缓存，避免重复导入。
pub fn take(id: &str) -> Option<PreparedImport> {
    cache().lock().unwrap().remove(id)
}
