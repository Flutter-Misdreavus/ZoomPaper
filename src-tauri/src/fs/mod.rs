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

/// 路径是否存在。
pub fn exists(path: &Path) -> bool {
    path.exists()
}
