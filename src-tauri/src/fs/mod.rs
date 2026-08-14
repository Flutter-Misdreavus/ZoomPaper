//! 论文库文件管理。
//!
//! 每篇论文一个目录：
//! ```text
//! papers/
//!   {uuid}/
//!     paper.pdf   # 原始 PDF
//!     paper.md    # MinerU 解析结果
//!     blog.md     # AI 生成的博客（Phase 3）
//! ```

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// 论文目录：`<library>/<paper_id>/`
pub fn paper_dir(library: &Path, paper_id: &str) -> PathBuf {
    library.join(paper_id)
}

/// 创建论文目录。
pub fn ensure_paper_dir(library: &Path, paper_id: &str) -> Result<PathBuf> {
    let dir = paper_dir(library, paper_id);
    fs::create_dir_all(&dir).context("创建论文目录失败")?;
    Ok(dir)
}

/// 把源 PDF 复制进论文目录，返回目标路径。
pub fn copy_pdf(src: &Path, library: &Path, paper_id: &str) -> Result<PathBuf> {
    let dir = ensure_paper_dir(library, paper_id)?;
    let dest = dir.join("paper.pdf");
    fs::copy(src, &dest).context("复制 PDF 失败")?;
    Ok(dest)
}

/// 读取 Markdown 文本。
pub fn read_md(path: &Path) -> Result<String> {
    fs::read_to_string(path).context("读取 Markdown 失败")
}

/// 写入 Markdown 文本。
pub fn write_md(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content).context("写入 Markdown 失败")
}

/// 把解析出的资源文件按相对路径写到 `dir` 下（自动建子目录）。
///
/// `files` 键形如 `images/xxx.jpg`、`content_list.json`，会分别落到
/// `dir/images/xxx.jpg`、`dir/content_list.json`。
pub fn write_extracted_files(dir: &Path, files: &[(String, Vec<u8>)]) -> Result<()> {
    for (rel, bytes) in files {
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).context("创建资源子目录失败")?;
        }
        fs::write(&dest, bytes).context("写入资源文件失败")?;
    }
    Ok(())
}

/// 路径是否存在。
pub fn exists(path: &Path) -> bool {
    path.exists()
}

/// 删除整篇论文目录（不存在则视为成功）。
pub fn remove_paper_dir(library: &Path, paper_id: &str) -> Result<()> {
    let dir = paper_dir(library, paper_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).context("删除论文目录失败")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_extracted_files_creates_subdirs() {
        let tmp = std::env::temp_dir().join(format!("zoompaper-fs-{}", uuid::Uuid::new_v4()));
        let files = vec![
            ("images/a.jpg".to_string(), b"jpeg-bytes".to_vec()),
            ("content_list.json".to_string(), b"{}".to_vec()),
        ];
        write_extracted_files(&tmp, &files).unwrap();

        assert!(tmp.join("images/a.jpg").exists());
        assert!(tmp.join("content_list.json").exists());
        assert_eq!(fs::read(tmp.join("images/a.jpg")).unwrap(), b"jpeg-bytes");

        fs::remove_dir_all(&tmp).ok();
    }
}
