//! 题录文件读取、Zotero 附件索引与 PDF 校验。

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::model::ReferenceFormat;

pub const MAX_REFERENCE_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_IMPORT_PDF_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ATTACHMENT_FILES: usize = 50_000;
const MAX_ATTACHMENT_DEPTH: usize = 8;

pub fn read_reference_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取题录文件失败：{e}"))?;
    if !metadata.is_file() {
        return Err("请选择题录文件".to_string());
    }
    if metadata.len() > MAX_REFERENCE_FILE_BYTES {
        return Err("题录文件超过 20 MB，已停止导入".to_string());
    }
    let bytes = fs::read(path).map_err(|e| format!("读取题录文件失败：{e}"))?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8(bytes[3..].to_vec()).map_err(|_| "题录文件不是有效 UTF-8".to_string())
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        decode_utf16(&bytes[2..], true)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        decode_utf16(&bytes[2..], false)
    } else {
        String::from_utf8(bytes).map_err(|_| {
            "题录文件编码不受支持，请使用 Zotero 默认的 UTF-8 导出".to_string()
        })
    }
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("UTF-16 题录文件长度无效".to_string());
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|_| "UTF-16 题录文件包含无效字符".to_string())
}

pub fn detect_format(path: &Path, content: &str) -> Result<ReferenceFormat, String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "bib" | "bibtex" => return Ok(ReferenceFormat::Bibtex),
        "ris" => return Ok(ReferenceFormat::Ris),
        _ => {}
    }
    let trimmed = content.trim_start();
    if trimmed.starts_with("TY  -") || trimmed.starts_with("TY -") {
        Ok(ReferenceFormat::Ris)
    } else if trimmed.starts_with('@') {
        Ok(ReferenceFormat::Bibtex)
    } else {
        Err("无法识别文件格式，请选择 Zotero 导出的 .bib 或 .ris 文件".to_string())
    }
}

/// 一次递归扫描建立的 PDF 文件名索引；只用于预览，不写任何文件。
pub struct AttachmentIndex {
    pub root: PathBuf,
    pub source_dir: PathBuf,
    by_name: HashMap<String, Vec<PathBuf>>,
    scanned: usize,
}

impl AttachmentIndex {
    /// 不递归扫描，只支持显式路径/相对路径解析。
    pub fn empty(source_dir: &Path) -> Self {
        Self {
            root: source_dir.to_path_buf(),
            source_dir: source_dir.to_path_buf(),
            by_name: HashMap::new(),
            scanned: 0,
        }
    }

    pub fn build(root: &Path, source_dir: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "附件目录不存在或不可访问".to_string())?;
        if !root.is_dir() {
            return Err("附件目录必须是文件夹".to_string());
        }
        let source_dir = source_dir
            .canonicalize()
            .unwrap_or_else(|_| source_dir.to_path_buf());
        let mut index = Self {
            source_dir,
            root,
            by_name: HashMap::new(),
            scanned: 0,
        };
        let root = index.root.clone();
        index.walk(&root, 0)?;
        Ok(index)
    }

    fn walk(&mut self, dir: &Path, depth: usize) -> Result<(), String> {
        if depth > MAX_ATTACHMENT_DEPTH || self.scanned >= MAX_ATTACHMENT_FILES {
            return Ok(());
        }
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) if depth == 0 => return Err("读取附件目录失败".to_string()),
            Err(_) => return Ok(()),
        };
        for entry in entries.filter_map(Result::ok) {
            if self.scanned >= MAX_ATTACHMENT_FILES {
                break;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                self.walk(&path, depth + 1)?;
            } else if metadata.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            {
                self.scanned += 1;
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                self.by_name.entry(name).or_default().push(path);
            }
        }
        Ok(())
    }

    /// 解析一条附件路径；显式路径优先，最后按文件名回退。
    pub fn resolve(&self, raw: &str) -> Option<PathBuf> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let mut candidates = Vec::new();
        if let Some(rest) = raw
            .strip_prefix("storage:")
            .or_else(|| raw.strip_prefix("Storage:"))
        {
            candidates.push(self.root.join(rest));
            candidates.push(self.source_dir.join(rest));
        } else if raw.starts_with("file://") {
            if let Ok(url) = reqwest::Url::parse(raw) {
                if let Ok(path) = url.to_file_path() {
                    candidates.push(path);
                }
            }
        } else {
            let path = Path::new(raw);
            if path.is_absolute() {
                candidates.push(path.to_path_buf());
            } else {
                candidates.push(self.source_dir.join(path));
                candidates.push(self.root.join(path));
            }
        }
        candidates
            .into_iter()
            .find(|path| is_pdf_file(path))
            .or_else(|| self.by_basename(raw))
    }

    /// 同名候选（预览中提示用户歧义）。
    pub fn candidates(&self, raw: &str) -> Vec<PathBuf> {
        let mut result = Vec::new();
        if let Some(path) = self.resolve(raw) {
            result.push(path);
        }
        if let Some(name) = Path::new(raw).file_name().and_then(|name| name.to_str()) {
            if let Some(paths) = self.by_name.get(&name.to_lowercase()) {
                for path in paths {
                    if !result.iter().any(|existing| existing == path) {
                        result.push(path.clone());
                    }
                }
            }
        }
        result
    }

    /// Zotero 标准导出通常不带 `file` 字段；按 PDF 文件名与题录标题/ citation key
    /// 做保守匹配。返回最多 5 个候选，交由预览界面确认。
    pub fn find_by_title(&self, title: &str, key: &str) -> Vec<PathBuf> {
        let title_compact = compact_alnum(title);
        let tokens: Vec<String> = title
            .split(|ch: char| !ch.is_alphanumeric())
            .filter(|token| token.chars().count() >= 3)
            .map(str::to_lowercase)
            .collect();
        if title_compact.is_empty() && key.is_empty() {
            return vec![];
        }
        let key_lower = key.to_lowercase();
        let mut result = Vec::new();
        for (name, paths) in &self.by_name {
            let stem = name.trim_end_matches(".pdf");
            let stem_compact = compact_alnum(stem);
            let key_match = !key_lower.is_empty() && stem_compact.contains(&key_lower);
            let title_match = if title_compact.chars().count() >= 8 {
                stem_compact.contains(&title_compact)
                    || (stem_compact.chars().count() >= 8
                        && title_compact.contains(&stem_compact))
            } else {
                false
            };
            let token_match = tokens.len() >= 3
                && {
                    let hits = tokens
                        .iter()
                        .filter(|token| stem_compact.contains(token.as_str()))
                        .count();
                    hits as f64 / tokens.len() as f64 >= 0.75
                };
            if key_match || title_match || token_match {
                for path in paths {
                    if is_pdf_file(path) && !result.iter().any(|existing| existing == path) {
                        result.push(path.clone());
                    }
                    if result.len() >= 5 {
                        return result;
                    }
                }
            }
        }
        result
    }

    fn by_basename(&self, raw: &str) -> Option<PathBuf> {        let raw = raw
            .strip_prefix("storage:")
            .or_else(|| raw.strip_prefix("Storage:"))
            .unwrap_or(raw);
        let name = Path::new(raw).file_name()?.to_str()?.to_lowercase();
        self.by_name
            .get(&name)
            .and_then(|paths| paths.iter().find(|path| is_pdf_file(path)).cloned())
    }
}

fn compact_alnum(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

pub fn is_pdf_file(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > MAX_IMPORT_PDF_BYTES || metadata.len() < 5 {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut signature = [0u8; 5];
    file.read_exact(&mut signature).is_ok() && &signature == b"%PDF-"
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取 PDF 失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("读取 PDF 失败：{e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!("zoom-ref-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn detects_bibtex_and_ris_by_extension_and_content() {
        assert_eq!(
            detect_format(Path::new("a.bib"), "@article{x, title={T}}").unwrap(),
            ReferenceFormat::Bibtex
        );
        assert_eq!(
            detect_format(Path::new("a.txt"), "TY  - JOUR\nTI  - T\nER  - ").unwrap(),
            ReferenceFormat::Ris
        );
        assert!(detect_format(Path::new("a.txt"), "hello").is_err());
    }

    #[test]
    fn indexes_pdfs_and_handles_storage_prefix() {
        let root = temp();
        fs::create_dir_all(root.join("storage/KEY")).unwrap();
        fs::write(root.join("storage/KEY/paper.pdf"), b"%PDF-test").unwrap();
        let index = AttachmentIndex::build(&root, &root).unwrap();
        assert_eq!(
            index.resolve("storage:paper.pdf").unwrap(),
            root.canonicalize()
                .unwrap()
                .join("storage/KEY/paper.pdf")
        );
    }

    #[test]
    fn finds_attachment_by_title_tokens() {
        let root = temp();
        fs::create_dir_all(root.join("storage/KEY")).unwrap();
        fs::write(
            root.join("storage/KEY/Gradient-Aware Retrieval.pdf"),
            b"%PDF-test",
        )
        .unwrap();
        let index = AttachmentIndex::build(&root, &root).unwrap();
        let found = index.find_by_title("Gradient Aware Retrieval", "smith2020");
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("Gradient-Aware Retrieval.pdf"));
        assert!(index
            .find_by_title("Completely Different Topic", "nope")
            .is_empty());
    }

    #[test]
    fn rejects_non_pdf_and_oversized_files() {
        let root = temp();
        fs::write(root.join("a.pdf"), b"not a pdf").unwrap();
        assert!(!is_pdf_file(&root.join("a.pdf")));
        fs::write(root.join("b.pdf"), b"%PDF-1.7").unwrap();
        assert!(is_pdf_file(&root.join("b.pdf")));
        fs::remove_dir_all(root).ok();
    }
}
