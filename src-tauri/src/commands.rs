//! Tauri 命令层：前端通过 invoke 调用。

use crate::ai::mineru::MineruClient;
use crate::db::models::Paper;
use crate::db::Db;
use crate::settings::Settings;
use rusqlite::params;
use std::path::Path;
use tauri::State;
use uuid::Uuid;

// ---------- 设置 ----------

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    Settings::load().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_settings(new_settings: Settings) -> Result<Settings, String> {
    new_settings.save().map_err(|e| e.to_string())?;
    Ok(new_settings)
}

// ---------- 论文 ----------

const PAPER_COLS: &str = "id, title, authors, abstract, pdf_path, md_path, \
                          blog_md_path, created_at, last_read_at, reading_status, parse_status";

fn row_to_paper(row: &rusqlite::Row) -> rusqlite::Result<Paper> {
    Ok(Paper {
        id: row.get(0)?,
        title: row.get(1)?,
        authors: row.get(2)?,
        abstract_text: row.get(3)?,
        pdf_path: row.get(4)?,
        md_path: row.get(5)?,
        blog_md_path: row.get(6)?,
        created_at: row.get(7)?,
        last_read_at: row.get(8)?,
        reading_status: row.get(9)?,
        parse_status: row.get(10)?,
    })
}

#[tauri::command]
pub fn list_papers(db: State<'_, Db>) -> Result<Vec<Paper>, String> {
    let conn = db.conn();
    let sql = format!("SELECT {PAPER_COLS} FROM papers ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_paper)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_paper(db: State<'_, Db>, paper_id: String) -> Result<Paper, String> {
    let conn = db.conn();
    let sql = format!("SELECT {PAPER_COLS} FROM papers WHERE id = ?1");
    conn.query_row(&sql, [&paper_id], row_to_paper)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_paper_md(db: State<'_, Db>, paper_id: String) -> Result<String, String> {
    let md_path = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let mut md = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
    // 把 MinerU 的相对图片路径（`](images/...`) 重写为绝对路径，供前端 convertFileSrc 加载
    if let Some(parent) = Path::new(&md_path).parent() {
        let dir = parent.to_string_lossy();
        md = md.replace("](images/", &format!("]({}/images/", dir));
    }
    Ok(md)
}

// ---------- 导入与解析 ----------

/// 导入论文：把源 PDF 复制进论文库并插入记录。
#[tauri::command]
pub fn import_pdf(db: State<'_, Db>, source_path: String) -> Result<Paper, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let library = settings.papers_dir().map_err(|e| e.to_string())?;
    import_pdf_inner(&db, &library, &source_path)
}

/// 核心导入逻辑（library 由调用方决定，便于测试）。
fn import_pdf_inner(db: &Db, library: &Path, source_path: &str) -> Result<Paper, String> {
    let id = Uuid::new_v4().to_string();
    let src = Path::new(source_path);
    let pdf_path = crate::fs::copy_pdf(src, library, &id).map_err(|e| e.to_string())?;
    let md_path = crate::fs::paper_dir(library, &id).join("paper.md");
    let now = chrono::Utc::now().timestamp();
    let title = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名论文".to_string());

    let paper = Paper {
        id: id.clone(),
        title,
        authors: None,
        abstract_text: None,
        pdf_path: pdf_path.to_string_lossy().to_string(),
        md_path: md_path.to_string_lossy().to_string(),
        blog_md_path: None,
        created_at: now,
        last_read_at: None,
        reading_status: "unread".to_string(),
        parse_status: "unparsed".to_string(),
    };

    let conn = db.conn();
    conn.execute(
        "INSERT INTO papers (id, title, authors, abstract, pdf_path, md_path, \
         blog_md_path, created_at, last_read_at, reading_status, parse_status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            &paper.id,
            &paper.title,
            paper.authors,
            paper.abstract_text,
            &paper.pdf_path,
            &paper.md_path,
            paper.blog_md_path,
            &paper.created_at,
            paper.last_read_at,
            &paper.reading_status,
            &paper.parse_status
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(paper)
}

/// 调用 MinerU 解析论文 Markdown 并更新状态。
#[tauri::command]
pub async fn parse_pdf(db: State<'_, Db>, paper_id: String) -> Result<Paper, String> {
    // 标记为解析中（不放锁跨 await）
    {
        let conn = db.conn();
        conn.execute(
            "UPDATE papers SET parse_status = 'parsing' WHERE id = ?1",
            [&paper_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 读取路径与 API Key
    let (pdf_path, md_path) = {
        let conn = db.conn();
        conn.query_row(
            "SELECT pdf_path, md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?
    };
    let api_key = Settings::load()
        .map_err(|e| e.to_string())?
        .api_keys
        .mineru;
    if api_key.is_empty() {
        return Err("未配置 MinerU API Key，请先在设置页填写".into());
    }

    // 网络调用（await 期间不持有数据库锁）
    let client = MineruClient::new(api_key);
    let output = client
        .extract_pdf(Path::new(&pdf_path))
        .await
        .map_err(|e| format!("MinerU 解析失败: {e}"))?;

    // 落盘 markdown + 图片 + 结构化 JSON（论文目录下）
    crate::fs::write_md(Path::new(&md_path), &output.markdown).map_err(|e| e.to_string())?;
    let paper_dir = Path::new(&md_path).parent().unwrap_or_else(|| Path::new("."));
    crate::fs::write_extracted_files(paper_dir, &output.files).map_err(|e| e.to_string())?;

    // 提取元数据并更新状态
    let (title, authors, abstract_text) = extract_metadata(&output.markdown);
    {
        let conn = db.conn();
        conn.execute(
            "UPDATE papers SET parse_status = 'ready', title = ?2, authors = ?3, abstract = ?4 \
             WHERE id = ?1",
            params![&paper_id, title, authors, abstract_text],
        )
        .map_err(|e| e.to_string())?;
    }

    get_paper(db, paper_id)
}

// ---------- 元数据提取（轻量启发式，Phase 2 再增强） ----------

fn extract_metadata(md: &str) -> (String, Option<String>, Option<String>) {
    let mut title = None;
    let mut abstract_lines = Vec::new();
    let mut in_abstract = false;

    for line in md.lines() {
        let trimmed = line.trim();
        if title.is_none() {
            if let Some(t) = trimmed.strip_prefix("# ") {
                title = Some(t.trim().to_string());
                continue;
            }
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                title = Some(trimmed.to_string()); // 兜底：第一个非空行
            }
        }

        // 去掉 markdown 标记（#、* 等）后再匹配标题，兼容 "## Abstract"、"**摘要**"
        let lower = trimmed
            .trim_start_matches(['#', '*', ' ', '-'])
            .to_lowercase();
        if lower.starts_with("abstract") || lower.starts_with("摘要") {
            in_abstract = true;
            continue;
        }
        if in_abstract {
            if lower.starts_with("1 ") || trimmed.starts_with('#') || lower.starts_with("introduction") {
                break;
            }
            if !trimmed.is_empty() {
                abstract_lines.push(trimmed.to_string());
            }
            if abstract_lines.len() >= 30 {
                break;
            }
        }
    }

    let title = title.unwrap_or_else(|| "未命名论文".to_string());
    let abstract_text = if abstract_lines.is_empty() {
        None
    } else {
        Some(abstract_lines.join(" "))
    };
    // authors 暂不提取（Markdown 中作者格式不稳定，Phase 2 处理）
    (title, None, abstract_text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::fs;

    #[test]
    fn import_copies_pdf_and_inserts_row() {
        db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::migrate(&conn).unwrap();
        let db = db::Db::from_connection(conn);

        let tmp = std::env::temp_dir().join(format!("zoompaper-test-{}", uuid::Uuid::new_v4()));
        let library = tmp.join("papers");
        let src = tmp.join("src-paper.pdf");
        fs::create_dir_all(&library).unwrap();
        fs::write(&src, b"%PDF-1.4 test").unwrap();

        let paper = import_pdf_inner(&db, &library, src.to_str().unwrap()).unwrap();
        assert_eq!(paper.parse_status, "unparsed");
        assert!(Path::new(&paper.pdf_path).exists(), "PDF 应被复制进论文库");
        assert_eq!(Path::new(&paper.pdf_path).parent().unwrap(), library.join(&paper.id));

        // 数据库里能查回
        let conn = db.conn();
        let stored: String = conn
            .query_row("SELECT title FROM papers WHERE id = ?1", [&paper.id], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "src-paper.pdf");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn metadata_extraction_gets_title_and_abstract() {
        let md = "# Attention Is All You Need\n\nSome author line.\n\n## Abstract\n\nThe dominant sequence transduction models are based on complex recurrent networks.\n\n## 1 Introduction\n\nBody text.";
        let (title, authors, abstract_text) = extract_metadata(md);
        assert_eq!(title, "Attention Is All You Need");
        assert_eq!(authors, None);
        assert!(abstract_text.unwrap().contains("dominant sequence transduction"));
    }
}
