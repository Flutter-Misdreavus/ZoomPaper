//! Tauri 命令层：前端通过 invoke 调用。

use crate::ai::llm::{Llm, Role};
use crate::ai::mineru::MineruClient;
use crate::db::models::{Conversation, Folder, Paper, SearchHit};
use crate::feynman::{
    ConceptStatus, FeynmanMessage, FeynmanState, FeynmanTurn, PlanItem, StageStatus,
};
use crate::qa::{Answer, QaMessage};
use crate::db::Db;
use crate::settings::Settings;
use rusqlite::{params, OptionalExtension};
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

/// 论文查询公共前缀：LEFT JOIN paper_folders 聚合所属文件夹（多归属）。
/// 调用方需追加 GROUP BY p.id（及可选 WHERE / ORDER BY）。
const PAPER_SELECT: &str = "
    SELECT p.id, p.title, p.authors, p.abstract, p.pdf_path, p.md_path, p.blog_md_path,
           p.created_at, p.last_read_at, p.reading_status, p.parse_status,
           GROUP_CONCAT(pf.folder_id)
    FROM papers p
    LEFT JOIN paper_folders pf ON pf.paper_id = p.id
";

fn row_to_paper(row: &rusqlite::Row) -> rusqlite::Result<Paper> {
    let folder_ids: Option<String> = row.get(11)?;
    let folder_ids = folder_ids
        .map(|s| {
            s.split(',')
                .filter(|x| !x.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
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
        folder_ids,
    })
}

#[tauri::command]
pub fn list_papers(db: State<'_, Db>) -> Result<Vec<Paper>, String> {
    list_papers_inner(&db)
}

fn list_papers_inner(db: &Db) -> Result<Vec<Paper>, String> {
    let conn = db.conn();
    let sql = format!("{PAPER_SELECT} GROUP BY p.id ORDER BY p.created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_paper)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_paper(db: State<'_, Db>, paper_id: String) -> Result<Paper, String> {
    get_paper_inner(&db, &paper_id)
}

fn get_paper_inner(db: &Db, paper_id: &str) -> Result<Paper, String> {
    let conn = db.conn();
    let sql = format!("{PAPER_SELECT} WHERE p.id = ?1 GROUP BY p.id");
    conn.query_row(&sql, [paper_id], row_to_paper)
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
        folder_ids: vec![],
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

    // 自动建立向量索引（失败不影响解析结果，仅记日志）
    {
        let conn = db.conn();
        if let Err(e) = crate::rag::index_paper(&conn, &paper_id) {
            eprintln!("索引论文 {paper_id} 失败: {e}");
        }
    }

    get_paper(db, paper_id)
}

/// 删除论文：级联清库（向量/分块/会话/论文行），再删磁盘目录。
/// 库删除成功后文件删除失败仅记日志，避免半态报错。
#[tauri::command]
pub fn delete_paper(db: State<'_, Db>, paper_id: String) -> Result<(), String> {
    {
        let conn = db.conn();
        for sql in [
            // vec0 虚表只支持按 rowid 删除，沿用 rag 重索引的写法
            "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM paper_chunks WHERE paper_id = ?1)",
            "DELETE FROM paper_chunks WHERE paper_id = ?1",
            "DELETE FROM conversations WHERE paper_id = ?1",
            "DELETE FROM papers WHERE id = ?1",
        ] {
            conn.execute(sql, [&paper_id]).map_err(|e| e.to_string())?;
        }
    }

    if let Ok(settings) = Settings::load() {
        if let Ok(library) = settings.papers_dir() {
            if let Err(e) = crate::fs::remove_paper_dir(&library, &paper_id) {
                eprintln!("删除论文目录 {paper_id} 失败: {e}");
            }
        }
    }
    Ok(())
}

// ---------- 论文整理（虚拟文件夹，多归属） ----------

const FOLDER_COLS: &str = "id, name, parent_id, color, tags, created_at";

fn row_to_folder(row: &rusqlite::Row) -> rusqlite::Result<Folder> {
    let tags_json: String = row.get(4)?;
    let tags = serde_json::from_str(&tags_json).unwrap_or_default();
    Ok(Folder {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        color: row.get(3)?,
        tags,
        created_at: row.get(5)?,
    })
}

fn get_folder_by_id(conn: &rusqlite::Connection, folder_id: &str) -> Result<Folder, String> {
    let sql = format!("SELECT {FOLDER_COLS} FROM folders WHERE id = ?1");
    conn.query_row(&sql, [folder_id], row_to_folder)
        .map_err(|e| e.to_string())
}

/// 同级重名校验：同一 parent_id（含 None=顶级）下不允许同名文件夹。
fn folder_name_taken(
    conn: &rusqlite::Connection,
    parent_id: Option<&str>,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT id, parent_id FROM folders WHERE name = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([name], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, pid) = row.map_err(|e| e.to_string())?;
        if Some(id.as_str()) == exclude_id {
            continue;
        }
        if pid.as_deref() == parent_id {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 列出全部文件夹（扁平返回，前端自组树）。
#[tauri::command]
pub fn list_folders(db: State<'_, Db>) -> Result<Vec<Folder>, String> {
    list_folders_inner(&db)
}

fn list_folders_inner(db: &Db) -> Result<Vec<Folder>, String> {
    let conn = db.conn();
    let sql = format!("SELECT {FOLDER_COLS} FROM folders ORDER BY created_at ASC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_folder)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 新建文件夹（parent_id 为 None = 顶级）。同级重名拒绝。
#[tauri::command]
pub fn create_folder(
    db: State<'_, Db>,
    name: String,
    parent_id: Option<String>,
    color: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Folder, String> {
    create_folder_inner(&db, &name, parent_id, color, tags)
}

fn create_folder_inner(
    db: &Db,
    name: &str,
    parent_id: Option<String>,
    color: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Folder, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("文件夹名称不能为空".into());
    }
    let color = color.unwrap_or_else(|| "gray".to_string());
    let tags = tags.unwrap_or_default();
    let conn = db.conn();
    if folder_name_taken(&conn, parent_id.as_deref(), &name, None)? {
        return Err("同级下已存在同名文件夹".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO folders (id, name, parent_id, color, tags, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&id, &name, parent_id, &color, &tags_json, now],
    )
    .map_err(|e| e.to_string())?;
    get_folder_by_id(&conn, &id)
}

/// 更新文件夹（重命名 / 改色 / 改标签；parent_id 重组预留，v1 不开放）。
#[tauri::command]
pub fn update_folder(
    db: State<'_, Db>,
    folder_id: String,
    name: Option<String>,
    color: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Folder, String> {
    update_folder_inner(&db, &folder_id, name, color, tags)
}

fn update_folder_inner(
    db: &Db,
    folder_id: &str,
    name: Option<String>,
    color: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Folder, String> {
    let conn = db.conn();
    let (old_name, parent_id): (String, Option<String>) = conn
        .query_row(
            "SELECT name, parent_id FROM folders WHERE id = ?1",
            [folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹不存在".to_string())?;

    let name = name.map(|n| n.trim().to_string()).unwrap_or(old_name);
    if name.is_empty() {
        return Err("文件夹名称不能为空".into());
    }
    if folder_name_taken(&conn, parent_id.as_deref(), &name, Some(folder_id))? {
        return Err("同级下已存在同名文件夹".into());
    }

    let color = color.unwrap_or_else(|| "gray".to_string());
    let tags = tags.unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE folders SET name = ?2, color = ?3, tags = ?4 WHERE id = ?1",
        params![folder_id, &name, &color, &tags_json],
    )
    .map_err(|e| e.to_string())?;
    get_folder_by_id(&conn, folder_id)
}

/// 删除文件夹：子文件夹上移一级（父变为被删文件夹的父），
/// paper_folders 由外键级联清除；**不删除任何论文**（受影响论文失去该归属）。
#[tauri::command]
pub fn delete_folder(db: State<'_, Db>, folder_id: String) -> Result<(), String> {
    delete_folder_inner(&db, &folder_id)
}

fn delete_folder_inner(db: &Db, folder_id: &str) -> Result<(), String> {
    let conn = db.conn();
    // 子文件夹的父指向被删文件夹的父（顶级则为 NULL）
    conn.execute(
        "UPDATE folders SET parent_id = \
             (SELECT parent_id FROM folders WHERE id = ?1) \
          WHERE parent_id = ?1",
        [folder_id],
    )
    .map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM folders WHERE id = ?1", [folder_id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("文件夹不存在".into());
    }
    Ok(())
}

/// 把多篇论文加入某文件夹（多归属添加语义；已存在的为 no-op）。返回实际新增条数。
#[tauri::command]
pub fn add_papers_to_folder(
    db: State<'_, Db>,
    paper_ids: Vec<String>,
    folder_id: String,
) -> Result<usize, String> {
    add_papers_to_folder_inner(&db, &paper_ids, &folder_id)
}

fn add_papers_to_folder_inner(
    db: &Db,
    paper_ids: &[String],
    folder_id: &str,
) -> Result<usize, String> {
    let conn = db.conn();
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM folders WHERE id = ?1",
            [folder_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("文件夹不存在".into());
    }
    let now = chrono::Utc::now().timestamp();
    let mut added = 0;
    for pid in paper_ids {
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO paper_folders (paper_id, folder_id, created_at) \
                 VALUES (?1, ?2, ?3)",
                params![pid, folder_id, now],
            )
            .map_err(|e| e.to_string())?;
        added += n;
    }
    Ok(added)
}

/// 把多篇论文从某文件夹移除归属（不删除论文）。返回实际移除条数。
#[tauri::command]
pub fn remove_papers_from_folder(
    db: State<'_, Db>,
    paper_ids: Vec<String>,
    folder_id: String,
) -> Result<usize, String> {
    remove_papers_from_folder_inner(&db, &paper_ids, &folder_id)
}

fn remove_papers_from_folder_inner(
    db: &Db,
    paper_ids: &[String],
    folder_id: &str,
) -> Result<usize, String> {
    let conn = db.conn();
    let mut removed = 0;
    for pid in paper_ids {
        let n = conn
            .execute(
                "DELETE FROM paper_folders WHERE paper_id = ?1 AND folder_id = ?2",
                params![pid, folder_id],
            )
            .map_err(|e| e.to_string())?;
        removed += n;
    }
    Ok(removed)
}

/// 重命名论文（仅更新 title 元数据；磁盘文件不动）。trim 后非空校验。
#[tauri::command]
pub fn rename_paper(db: State<'_, Db>, paper_id: String, new_title: String) -> Result<Paper, String> {
    rename_paper_inner(&db, &paper_id, &new_title)
}

fn rename_paper_inner(db: &Db, paper_id: &str, new_title: &str) -> Result<Paper, String> {
    let title = new_title.trim().to_string();
    if title.is_empty() {
        return Err("论文标题不能为空".into());
    }
    {
        let conn = db.conn();
        let n = conn
            .execute(
                "UPDATE papers SET title = ?2 WHERE id = ?1",
                params![paper_id, &title],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("论文不存在".into());
        }
    }
    get_paper_inner(db, paper_id)
}

// ---------- 检索 / 索引 ----------

/// 手动重建某篇论文的向量索引。返回 chunk 数量。
#[tauri::command]
pub fn index_paper(db: State<'_, Db>, paper_id: String) -> Result<usize, String> {
    let conn = db.conn();
    crate::rag::index_paper(&conn, &paper_id).map_err(|e| e.to_string())
}

/// 向量检索。`paper_id` 为 `Some` 时只在该论文内检索。
#[tauri::command]
pub fn search(
    db: State<'_, Db>,
    query: String,
    top_k: usize,
    paper_id: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    let conn = db.conn();
    crate::rag::search(&conn, &query, top_k, paper_id.as_deref()).map_err(|e| e.to_string())
}

// ---------- 博客生成 ----------

/// 调用 LLM 生成博客（科普版正文 + 第一性原理深度剖析），落盘 `blog.md` 并回写
/// `blog_md_path`。返回组合后的博客 Markdown 文本。
#[tauri::command]
pub async fn generate_blog(
    db: State<'_, Db>,
    paper_id: String,
) -> Result<String, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = crate::ai::llm::Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    // 读论文 Markdown 全文
    let md_path = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let markdown = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
    // 提取论文图表清单（编号 + 说明 + 相对路径），供博客正文嵌入原图
    let figures = crate::blog::extract_figures(&markdown);

    // 生成（网络调用，await 期间不持有数据库锁）
    let blog = crate::blog::generate_blog(&llm, &markdown, &figures)
        .await
        .map_err(|e| e.to_string())?;

    // 落盘 blog.md 并回写路径
    let blog_path = Path::new(&md_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("blog.md");
    crate::fs::write_md(&blog_path, &blog).map_err(|e| e.to_string())?;
    let blog_path_str = blog_path.to_string_lossy().to_string();
    {
        let conn = db.conn();
        conn.execute(
            "UPDATE papers SET blog_md_path = ?2 WHERE id = ?1",
            params![&paper_id, &blog_path_str],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(blog)
}

// ---------- AI 翻译 ----------

/// 翻译单个英文块为中文（前端分块后逐块调用）。
#[tauri::command]
pub async fn translate_chunk(text: String) -> Result<String, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = crate::ai::llm::Llm::from_settings(&settings).map_err(|e| e.to_string())?;
    let zh = crate::translate::translate_text(&llm, &text)
        .await
        .map_err(|e| e.to_string())?;
    Ok(zh.trim().to_string())
}

/// 把翻译结果（en/zh 分块对）落盘为论文目录下的 translation.json。
#[tauri::command]
pub fn save_translation(
    db: State<'_, Db>,
    paper_id: String,
    chunks: Vec<crate::translate::TranslationChunk>,
) -> Result<(), String> {
    let md_path = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let file = crate::translate::TranslationFile {
        version: crate::translate::CURRENT_VERSION,
        chunks,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    let path = Path::new(&md_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("translation.json");
    crate::fs::write_md(&path, &json).map_err(|e| e.to_string())
}

/// 读取论文的翻译缓存（translation.json），不存在则返回 None。
#[tauri::command]
pub fn get_translation(
    db: State<'_, Db>,
    paper_id: String,
) -> Result<Option<Vec<crate::translate::TranslationChunk>>, String> {
    let md_path = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let path = Path::new(&md_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("translation.json");
    if !path.exists() {
        return Ok(None);
    }
    let json = crate::fs::read_md(&path).map_err(|e| e.to_string())?;
    // 新版结构为 { version, chunks }；旧版缓存是纯数组 [{en,zh},...]（或文件损坏）——
    // 解析失败一律视为无缓存返回 None，让前端重新翻译，不把解析错误抛给用户。
    let file: crate::translate::TranslationFile = match serde_json::from_str(&json) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };
    // 旧版本号（格式已变更）同样视为不存在
    if file.version != crate::translate::CURRENT_VERSION {
        return Ok(None);
    }
    Ok(Some(file.chunks))
}

// ---------- 阅读标注（高亮 / 笔记） ----------

/// 读取论文的阅读标注（annotations.json），不存在则返回 None。
/// 返回原始 JSON 字符串，schema 由前端维护（与 save 侧对称）。
#[tauri::command]
pub fn get_annotations(
    db: State<'_, Db>,
    paper_id: String,
) -> Result<Option<String>, String> {
    get_annotations_inner(&db, &paper_id)
}

fn get_annotations_inner(db: &Db, paper_id: &str) -> Result<Option<String>, String> {
    let md_path = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [paper_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let path = Path::new(&md_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("annotations.json");
    if !path.exists() {
        return Ok(None);
    }
    let json = crate::fs::read_md(&path).map_err(|e| e.to_string())?;
    Ok(Some(json))
}

/// 把阅读标注（高亮 / 笔记，前端序列化的 JSON）落盘为论文目录下的 annotations.json。
#[tauri::command]
pub fn save_annotations(
    db: State<'_, Db>,
    paper_id: String,
    data: String,
) -> Result<(), String> {
    save_annotations_inner(&db, &paper_id, &data)
}

fn save_annotations_inner(db: &Db, paper_id: &str, data: &str) -> Result<(), String> {
    let md_path = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [paper_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let path = Path::new(&md_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("annotations.json");
    crate::fs::write_md(&path, data).map_err(|e| e.to_string())
}

// ---------- RAG 问答 ----------

const QA_TITLE_CHARS: usize = 40;

/// 一轮 RAG 问答：检索 + LLM 带引用回答，并持久化到 conversations。
/// `conversation_id` 为 `Some` 时续接多轮；`paper_id` 为 `Some` 时限定单篇检索。
#[tauri::command]
pub async fn ask_question(
    db: State<'_, Db>,
    question: String,
    paper_id: Option<String>,
    conversation_id: Option<String>,
    top_k: Option<usize>,
    selections: Option<Vec<crate::qa::SelectionInput>>,
) -> Result<Answer, String> {
    let top_k = top_k.unwrap_or(5);
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = crate::ai::llm::Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    // 取/建会话与历史
    let now = chrono::Utc::now().timestamp();
    let conv_id: String;
    let mut history: Vec<QaMessage>;
    {
        let conn = db.conn();
        match conversation_id {
            Some(id) => {
                let messages_json: String = conn
                    .query_row(
                        "SELECT messages FROM conversations WHERE id = ?1",
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("会话不存在: {e}"))?;
                history = serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
                conv_id = id;
            }
            None => {
                conv_id = Uuid::new_v4().to_string();
                let title = crate::qa::truncate(&question, QA_TITLE_CHARS);
                let pid = paper_id.as_deref();
                conn.execute(
                    "INSERT INTO conversations \
                     (id, paper_id, type, title, messages, created_at, updated_at) \
                     VALUES (?1, ?2, 'qa', ?3, '[]', ?4, ?4)",
                    params![&conv_id, pid, &title, now],
                )
                .map_err(|e| e.to_string())?;
                history = vec![];
            }
        }
    }

    // 检索 + 组装（同步，用完即释放数据库锁）；选中段落（可多条）作为强上下文注入
    let prepared = {
        let conn = db.conn();
        crate::qa::prepare(
            &conn,
            &question,
            paper_id.as_deref(),
            &history,
            top_k,
            selections.as_deref().unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?
    };

    // LLM（await 期间不持有数据库锁）
    let (answer, citations) = crate::qa::ask(&llm, &prepared)
        .await
        .map_err(|e| e.to_string())?;

    // 追加 user + assistant 两条消息并写回
    {
        let conn = db.conn();
        history.push(QaMessage {
            role: Role::User,
            content: question.clone(),
            citations: None,
        });
        history.push(QaMessage {
            role: Role::Assistant,
            content: answer.clone(),
            citations: Some(citations.clone()),
        });
        let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET messages = ?2, updated_at = ?3 WHERE id = ?1",
            params![&conv_id, messages_json, now],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(Answer {
        conversation_id: conv_id,
        answer,
        citations,
    })
}

/// 列出所有问答会话（按更新时间倒序）。
#[tauri::command]
pub fn list_conversations(db: State<'_, Db>) -> Result<Vec<Conversation>, String> {
    let conn = db.conn();
    let sql = "SELECT id, paper_id, type, title, messages, created_at, updated_at, notes, summary, feynman_state \
               FROM conversations WHERE type = 'qa' ORDER BY updated_at DESC";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                paper_id: r.get(1)?,
                conv_type: r.get(2)?,
                title: r.get(3)?,
                messages: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                notes: r.get(7)?,
                summary: r.get(8)?,
                feynman_state: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 读回单个会话（含完整 messages JSON）。
#[tauri::command]
pub fn get_conversation(
    db: State<'_, Db>,
    conversation_id: String,
) -> Result<Conversation, String> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, paper_id, type, title, messages, created_at, updated_at, notes, summary, feynman_state \
         FROM conversations WHERE id = ?1",
        [&conversation_id],
        |r| {
            Ok(Conversation {
                id: r.get(0)?,
                paper_id: r.get(1)?,
                conv_type: r.get(2)?,
                title: r.get(3)?,
                messages: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                notes: r.get(7)?,
                summary: r.get(8)?,
                feynman_state: r.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

// ---------- 费曼学习法（闯关式教学流） ----------

/// 解析会话的闯关状态 JSON；NULL / 空串视为旧版自由聊天会话（返回 None）。
fn parse_state_json(raw: Option<String>) -> Result<Option<FeynmanState>, String> {
    match raw {
        None => Ok(None),
        Some(s) if s.trim().is_empty() => Ok(None),
        Some(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("闯关状态解析失败: {e}")),
    }
}

/// 读会话的闯关状态；会话不存在或解析失败返回 Err。
fn load_feynman_state(
    conn: &rusqlite::Connection,
    conv_id: &str,
) -> Result<Option<FeynmanState>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT feynman_state FROM conversations WHERE id = ?1",
            [conv_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    parse_state_json(raw)
}

/// 写回会话的闯关状态。
fn save_feynman_state(
    conn: &rusqlite::Connection,
    conv_id: &str,
    state: &FeynmanState,
) -> Result<(), String> {
    let raw = serde_json::to_string(state).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE conversations SET feynman_state = ?2 WHERE id = ?1",
        params![conv_id, raw],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 生成概念计划：调 LLM 解析概念地图 JSON；失败重试一次，仍失败回退最小计划。
async fn generate_plan(llm: &Llm, toc: &str, full_paper: &str) -> Vec<PlanItem> {
    let messages = crate::feynman::build_plan_messages(toc, full_paper);
    for _ in 0..2 {
        match llm.chat(&messages).await {
            Ok(raw) => {
                if let Some(plan) = crate::feynman::parse_plan(&raw) {
                    return plan;
                }
            }
            Err(_) => continue,
        }
    }
    vec![PlanItem {
        name: "论文核心内容".to_string(),
        objective: "能用自己的话概括这篇论文解决了什么问题、用了什么方法、得出什么结论。".to_string(),
    }]
}

/// 检索相关段落 → 升级为章节全文 + 章节地图（纯 DB，无 LLM）。
fn retrieve_context(
    conn: &rusqlite::Connection,
    paper_id: &str,
    query: &str,
) -> Result<(String, String), String> {
    let hits = crate::rag::search(conn, query, crate::feynman::TOP_K, Some(paper_id))
        .map_err(|e| e.to_string())?;
    let sections = crate::rag::expand_sections(
        conn,
        paper_id,
        &hits,
        crate::feynman::MAX_SECTIONS,
        crate::feynman::SECTION_MAX_CHARS,
        crate::feynman::SECTION_CTX_TOTAL_MAX,
    )
    .map_err(|e| e.to_string())?;
    let context = crate::feynman::build_section_context(&sections);
    let toc_sections = crate::rag::sections_for_paper(conn, paper_id).map_err(|e| e.to_string())?;
    let toc = crate::feynman::build_toc(&toc_sections);
    Ok((toc, context))
}

/// 开始费曼会话：通读论文全文 → 生成概念计划（planning 阶段）→ 学生开场白介绍路线，
/// 并新建会话持久化（含闯关状态）。无需用户输入；返回开场白 + 新会话 id + 状态。
#[tauri::command]
pub async fn feynman_start(db: State<'_, Db>, paper_id: String) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().timestamp();

    // 锁内：读论文 md 路径
    let md_path: String = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };

    // 无锁：首轮通读全文（一次性，作为计划与开场白上下文）
    let markdown = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
    let full_paper = crate::feynman::build_full_paper(&markdown);

    // 锁内：读章节地图（TOC）
    let toc = {
        let conn = db.conn();
        let sections = crate::rag::sections_for_paper(&conn, &paper_id).map_err(|e| e.to_string())?;
        crate::feynman::build_toc(&sections)
    };

    // 无锁：生成概念计划 + 学生开场白（await 期间不持有数据库锁）
    let plan = generate_plan(&llm, &toc, &full_paper).await;
    let opening = llm
        .chat(&crate::feynman::build_plan_opening_messages(&toc, &full_paper, &plan))
        .await
        .map_err(|e| e.to_string())?;

    // 锁内：新建会话（含闯关状态）并写入开场白消息
    let conv_id = Uuid::new_v4().to_string();
    let state = FeynmanState::new(plan);
    let history = vec![FeynmanMessage {
        role: Role::Assistant,
        content: opening.clone(),
    }];
    let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
    let state_json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO conversations \
             (id, paper_id, type, title, messages, created_at, updated_at, feynman_state) \
             VALUES (?1, ?2, 'feynman', '费曼学习', ?3, ?4, ?4, ?5)",
            params![&conv_id, &paper_id, &messages_json, now, &state_json],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(FeynmanTurn {
        conversation_id: conv_id,
        reply: opening,
        state: Some(state),
    })
}

/// 为当前概念生成「引导提问」：检索该概念相关章节 → LLM 以学生口吻提出一个引导问题 →
/// 追加 assistant 消息并写回状态与历史。确认计划后从第一个概念、以及每次进入下一概念时调用。
async fn ask_concept_opening(
    db: &Db,
    llm: &Llm,
    conv_id: &str,
    state: &FeynmanState,
    history: &mut Vec<FeynmanMessage>,
    now: i64,
) -> Result<String, String> {
    let concept = state
        .current_concept()
        .cloned()
        .ok_or_else(|| "教学计划为空".to_string())?;
    let paper_id: String = {
        let conn = db.conn();
        conn.query_row(
            "SELECT paper_id FROM conversations WHERE id = ?1",
            [conv_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
        .ok_or_else(|| "会话缺少论文".to_string())?
    };
    let query = format!("{} {}", concept.name, concept.objective);
    let (toc, context) = {
        let conn = db.conn();
        retrieve_context(&conn, &paper_id, &query)?
    };
    let (_, window) = crate::feynman::split_window(history, crate::feynman::WINDOW_MAX_MSGS);
    let reply = crate::feynman::turn(
        &llm,
        &crate::feynman::build_concept_opening_messages(
            &toc,
            &context,
            &window,
            &concept.name,
            &concept.objective,
        ),
    )
    .await
    .map_err(|e| e.to_string())?;
    {
        let conn = db.conn();
        history.push(FeynmanMessage {
            role: Role::Assistant,
            content: reply.clone(),
        });
        let messages_json = serde_json::to_string(history).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET messages = ?2, updated_at = ?3 WHERE id = ?1",
            params![conv_id, messages_json, now],
        )
        .map_err(|e| e.to_string())?;
        save_feynman_state(&conn, conv_id, state)?;
    }
    Ok(reply)
}

/// 确认/编辑教学计划：归一化计划并写入状态，进入教学阶段（首个概念置为 teaching），
/// 然后学生针对第一个概念提出引导问题，邀请老师开始讲解。
/// 旧版自由聊天会话也会被初始化为闯关模式。
#[tauri::command]
pub async fn feynman_confirm_plan(
    db: State<'_, Db>,
    conversation_id: String,
    plan: Vec<PlanItem>,
) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();

    let normalized = crate::feynman::normalize_plan(plan);
    if normalized.is_empty() {
        return Err("教学计划不能为空，请至少保留一个概念".to_string());
    }
    let mut state = FeynmanState::new(normalized);
    state.status = StageStatus::Teaching;
    if let Some(first) = state.concepts.first_mut() {
        first.status = ConceptStatus::Teaching;
    }

    // 锁内：读历史（无锁阶段再生成提问，避免持锁 await）
    let history: Vec<FeynmanMessage> = {
        let conn = db.conn();
        let messages_json: String = conn
            .query_row(
                "SELECT messages FROM conversations WHERE id = ?1",
                [&conversation_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("会话不存在: {e}"))?;
        serde_json::from_str(&messages_json).map_err(|e| e.to_string())?
    };

    let mut history = history;
    let reply =
        ask_concept_opening(&db, &llm, &conversation_id, &state, &mut history, now).await?;

    Ok(FeynmanTurn {
        conversation_id,
        reply,
        state: Some(state),
    })
}

/// 一轮费曼对话（闯关模式）：
/// - quiz 阶段：只追加老师作答，不调用 LLM（交卷由 `feynman_judge` 统一判定）；
/// - planning 阶段：收到讲解即自动确认 AI 计划，进入首个概念教学；
/// - 当前概念已通过而老师直接发消息：自动进入下一概念；
/// - teaching 阶段：检索相关章节全文 + 章节地图 + 历史滚动窗口摘要 + LLM 学生式回应。
/// 旧会话（无 feynman_state）走遗留自由聊天管线（不含上述状态逻辑）。
/// `conversation_id` 为 `Some` 时续接多轮；否则新建会话并自动生成计划进入闯关模式。
#[tauri::command]
pub async fn feynman_turn(
    db: State<'_, Db>,
    paper_id: String,
    message: String,
    conversation_id: Option<String>,
) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().timestamp();
    let conv_id: String;
    let mut history: Vec<FeynmanMessage>;
    let summary: Option<String>;
    let mut state: Option<FeynmanState>;
    let md_path: String;

    // 取/建会话，读历史 + 已有「教学进展」摘要 + 闯关状态 + 论文 md 路径
    {
        let conn = db.conn();
        md_path = conn
            .query_row(
                "SELECT md_path FROM papers WHERE id = ?1",
                [&paper_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        match conversation_id.as_deref() {
            Some(id) => {
                let (messages_json, existing_summary, state_raw): (String, Option<String>, Option<String>) =
                    conn.query_row(
                        "SELECT messages, summary, feynman_state FROM conversations WHERE id = ?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .map_err(|e| format!("会话不存在: {e}"))?;
                history = serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
                summary = existing_summary;
                state = parse_state_json(state_raw)?;
                conv_id = id.to_string();
            }
            None => {
                conv_id = Uuid::new_v4().to_string();
                let title = crate::qa::truncate(&message, QA_TITLE_CHARS);
                conn.execute(
                    "INSERT INTO conversations \
                     (id, paper_id, type, title, messages, created_at, updated_at) \
                     VALUES (?1, ?2, 'feynman', ?3, '[]', ?4, ?4)",
                    params![&conv_id, &paper_id, &title, now],
                )
                .map_err(|e| e.to_string())?;
                history = vec![];
                summary = None;
                state = None;
            }
        }
    }

    // 新会话（无 id，用户直接输入开场）：生成概念计划并自动确认，进入闯关模式
    let mut full_paper: Option<String> = None;
    if conversation_id.is_none() {
        let markdown = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
        let fp = crate::feynman::build_full_paper(&markdown);
        let toc = {
            let conn = db.conn();
            let sections =
                crate::rag::sections_for_paper(&conn, &paper_id).map_err(|e| e.to_string())?;
            crate::feynman::build_toc(&sections)
        };
        let plan = generate_plan(&llm, &toc, &fp).await;
        let mut st = FeynmanState::new(plan);
        st.status = StageStatus::Teaching;
        if let Some(first) = st.concepts.first_mut() {
            first.status = ConceptStatus::Teaching;
        }
        {
            let conn = db.conn();
            save_feynman_state(&conn, &conv_id, &st)?;
        }
        state = Some(st);
        full_paper = Some(fp);
    }

    // 闯关状态机：quiz 只追加作答；planning 自动确认；已通过概念直接发消息 → 自动下一关
    if let Some(st) = state.as_mut() {
        if st.status == StageStatus::Quiz {
            history.push(FeynmanMessage {
                role: Role::User,
                content: message.clone(),
            });
            let conn = db.conn();
            let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE conversations SET messages = ?2, updated_at = ?3 WHERE id = ?1",
                params![&conv_id, messages_json, now],
            )
            .map_err(|e| e.to_string())?;
            save_feynman_state(&conn, &conv_id, st)?;
            return Ok(FeynmanTurn {
                conversation_id: conv_id,
                reply: String::new(),
                state: Some(st.clone()),
            });
        }
        if st.status == StageStatus::Planning {
            st.status = StageStatus::Teaching;
            if let Some(first) = st.concepts.first_mut() {
                first.status = ConceptStatus::Teaching;
            }
        }
        if st.status == StageStatus::Teaching {
            let cur_passed = st
                .current_concept_state()
                .map(|c| c.status == ConceptStatus::Passed)
                .unwrap_or(false);
            if cur_passed {
                if st.current_index + 1 >= st.plan.len() {
                    st.status = StageStatus::Done;
                } else {
                    st.current_index += 1;
                    if let Some(cs) = st.concepts.get_mut(st.current_index) {
                        cs.status = ConceptStatus::Teaching;
                    }
                }
            }
        }
    }

    // 无锁：首轮（新会话 / 历史为空）通读全文，放入 system；已有会话不带全文
    if history.is_empty() && full_paper.is_none() {
        let markdown = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
        full_paper = Some(crate::feynman::build_full_paper(&markdown));
    }

    // 无锁：检索上下文（闯关模式锚定当前概念；遗留模式用消息本身）
    let query = match state.as_ref() {
        Some(st) => {
            let concept = st.current_concept().map(|c| c.name.as_str()).unwrap_or("");
            let objective = st.current_concept().map(|c| c.objective.as_str()).unwrap_or("");
            format!("{concept} {objective} {message}")
        }
        None => message.clone(),
    };
    let (toc, context) = {
        let conn = db.conn();
        retrieve_context(&conn, &paper_id, &query)?
    };

    // 无锁：历史滑出窗口则在线压缩「教学进展」摘要（窗口溢出时一次，非每轮）
    let (overflow, window) =
        crate::feynman::split_window(&history, crate::feynman::WINDOW_MAX_MSGS);
    let new_summary: Option<String> = if overflow.is_empty() {
        summary
    } else {
        Some(
            crate::feynman::roll_summary(&llm, summary.as_deref(), &overflow)
                .await
                .map_err(|e| e.to_string())?,
        )
    };

    // 无锁：组装并调用 LLM（await 期间不持有数据库锁）
    let stage_note = match state.as_ref() {
        Some(st) => crate::feynman::build_stage_note(st),
        None => String::new(),
    };
    let reply = crate::feynman::turn(
        &llm,
        &crate::feynman::build_turn_messages(
            &toc,
            full_paper.as_deref(),
            new_summary.as_deref(),
            &context,
            &window,
            &message,
            &stage_note,
        ),
    )
    .await
    .map_err(|e| e.to_string())?;

    // 锁内：追加 user + assistant 两条消息并写回（含滚动摘要与可能更新的状态）
    {
        let conn = db.conn();
        history.push(FeynmanMessage {
            role: Role::User,
            content: message.clone(),
        });
        history.push(FeynmanMessage {
            role: Role::Assistant,
            content: reply.clone(),
        });
        let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET messages = ?2, summary = ?3, updated_at = ?4 WHERE id = ?1",
            params![&conv_id, messages_json, new_summary, now],
        )
        .map_err(|e| e.to_string())?;
        if let Some(st) = state.as_ref() {
            save_feynman_state(&conn, &conv_id, st)?;
        }
    }

    Ok(FeynmanTurn {
        conversation_id: conv_id,
        reply,
        state,
    })
}

/// 对当前概念出测验题：检索该概念相关章节 → LLM 出题 → 追加学生消息，状态置为 quiz。
#[tauri::command]
pub async fn feynman_quiz(
    db: State<'_, Db>,
    conversation_id: String,
) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();

    let (mut history, summary, state): (Vec<FeynmanMessage>, Option<String>, Option<FeynmanState>) = {
        let conn = db.conn();
        let (messages_json, existing_summary, state_raw): (String, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT messages, summary, feynman_state FROM conversations WHERE id = ?1",
                [&conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| format!("会话不存在: {e}"))?;
        (
            serde_json::from_str(&messages_json).map_err(|e| e.to_string())?,
            existing_summary,
            parse_state_json(state_raw)?,
        )
    };
    let mut state = state.ok_or_else(|| "当前会话不是闯关模式".to_string())?;
    match state.status {
        StageStatus::Teaching => {}
        StageStatus::Quiz => return Err("测验已在进行中，请先作答并交卷".to_string()),
        StageStatus::Planning => return Err("请先确认教学计划".to_string()),
        StageStatus::Done => return Err("全部概念已讲完，无需再测验".to_string()),
    }
    let concept = state
        .current_concept()
        .cloned()
        .ok_or_else(|| "教学计划为空".to_string())?;
    let attempts = state
        .current_concept_state()
        .map(|c| c.quiz_attempts)
        .unwrap_or(0);

    // 锁内：取论文 id
    let paper_id: String = {
        let conn = db.conn();
        conn.query_row(
            "SELECT paper_id FROM conversations WHERE id = ?1",
            [&conversation_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
        .ok_or_else(|| "会话缺少论文".to_string())?
    };

    // 无锁：检索当前概念相关章节
    let query = format!("{} {}", concept.name, concept.objective);
    let (toc, context) = {
        let conn = db.conn();
        retrieve_context(&conn, &paper_id, &query)?
    };

    // 无锁：滚动摘要 + 出题
    let (overflow, window) =
        crate::feynman::split_window(&history, crate::feynman::WINDOW_MAX_MSGS);
    let new_summary: Option<String> = if overflow.is_empty() {
        summary
    } else {
        Some(
            crate::feynman::roll_summary(&llm, summary.as_deref(), &overflow)
                .await
                .map_err(|e| e.to_string())?,
        )
    };
    let reply = crate::feynman::turn(
        &llm,
        &crate::feynman::build_quiz_messages(
            &toc,
            new_summary.as_deref(),
            &context,
            &window,
            &concept.name,
            &concept.objective,
            attempts,
        ),
    )
    .await
    .map_err(|e| e.to_string())?;

    // 锁内：追加学生出题消息 + 状态置为 quiz
    state.status = StageStatus::Quiz;
    {
        let conn = db.conn();
        history.push(FeynmanMessage {
            role: Role::Assistant,
            content: reply.clone(),
        });
        let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET messages = ?2, summary = ?3, updated_at = ?4 WHERE id = ?1",
            params![&conversation_id, messages_json, new_summary, now],
        )
        .map_err(|e| e.to_string())?;
        save_feynman_state(&conn, &conversation_id, &state)?;
    }

    Ok(FeynmanTurn {
        conversation_id,
        reply,
        state: Some(state),
    })
}

/// 交卷判定：收集「出题消息之后」的用户作答 → LLM 判定 通过/需补讲 → 更新状态并追加判定消息。
/// 通过且为最后一个概念 → done；通过非末位 → 保持 teaching（前端可点「下一概念」）；
/// 需补讲 → 记录缺口与次数，回到 teaching 补讲（测验次数 ≥1 次后出题会自动降难度）。
#[tauri::command]
pub async fn feynman_judge(
    db: State<'_, Db>,
    conversation_id: String,
) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();

    let (mut history, summary, state): (Vec<FeynmanMessage>, Option<String>, Option<FeynmanState>) = {
        let conn = db.conn();
        let (messages_json, existing_summary, state_raw): (String, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT messages, summary, feynman_state FROM conversations WHERE id = ?1",
                [&conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| format!("会话不存在: {e}"))?;
        (
            serde_json::from_str(&messages_json).map_err(|e| e.to_string())?,
            existing_summary,
            parse_state_json(state_raw)?,
        )
    };
    let mut state = state.ok_or_else(|| "当前会话不是闯关模式".to_string())?;
    if state.status != StageStatus::Quiz {
        return Err("当前没有待判定的测验，请先点「测验我」".to_string());
    }

    // 出题消息 = 最后一个 assistant 消息；其后的 user 消息为作答
    let last_assistant = history.iter().rposition(|m| m.role == Role::Assistant);
    let has_answers = match last_assistant {
        Some(i) => history[i + 1..].iter().any(|m| m.role == Role::User),
        None => false,
    };
    if !has_answers {
        return Err("还没有作答内容，请先在对话中回答测验题".to_string());
    }

    let concept = state
        .current_concept()
        .cloned()
        .ok_or_else(|| "教学计划为空".to_string())?;
    let paper_id: String = {
        let conn = db.conn();
        conn.query_row(
            "SELECT paper_id FROM conversations WHERE id = ?1",
            [&conversation_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
        .ok_or_else(|| "会话缺少论文".to_string())?
    };

    // 无锁：检索 + 滚动摘要 + 判定
    let query = format!("{} {}", concept.name, concept.objective);
    let (toc, context) = {
        let conn = db.conn();
        retrieve_context(&conn, &paper_id, &query)?
    };
    let (overflow, window) =
        crate::feynman::split_window(&history, crate::feynman::WINDOW_MAX_MSGS);
    let new_summary: Option<String> = if overflow.is_empty() {
        summary
    } else {
        Some(
            crate::feynman::roll_summary(&llm, summary.as_deref(), &overflow)
                .await
                .map_err(|e| e.to_string())?,
        )
    };
    let reply = crate::feynman::turn(
        &llm,
        &crate::feynman::build_judge_messages(
            &toc,
            new_summary.as_deref(),
            &context,
            &window,
            &concept.name,
            &concept.objective,
        ),
    )
    .await
    .map_err(|e| e.to_string())?;

    let passed = crate::feynman::parse_judge_verdict(&reply);
    let is_last = state.current_index + 1 >= state.plan.len();
    if let Some(cs) = state.concepts.get_mut(state.current_index) {
        cs.quiz_attempts += 1;
        if passed {
            cs.status = ConceptStatus::Passed;
            cs.taught_at = Some(now);
            cs.weak_points.clear();
        } else {
            cs.status = ConceptStatus::Weak;
            let note: String = reply.chars().take(200).collect();
            cs.weak_points = vec![note];
        }
    }
    state.status = if passed && is_last {
        StageStatus::Done
    } else {
        StageStatus::Teaching
    };

    // 锁内：追加判定消息 + 写回状态
    {
        let conn = db.conn();
        history.push(FeynmanMessage {
            role: Role::Assistant,
            content: reply.clone(),
        });
        let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET messages = ?2, summary = ?3, updated_at = ?4 WHERE id = ?1",
            params![&conversation_id, messages_json, new_summary, now],
        )
        .map_err(|e| e.to_string())?;
        save_feynman_state(&conn, &conversation_id, &state)?;
    }

    Ok(FeynmanTurn {
        conversation_id,
        reply,
        state: Some(state),
    })
}

/// 进入下一概念：校验当前概念已通过，推进 current_index 并标记下一个为 teaching，
/// 然后学生针对新概念提出引导问题，邀请老师开始讲解。
/// 最后一个概念通过后由 `feynman_judge` 直接置为 done（此命令的 Done 分支为防御）。
#[tauri::command]
pub async fn feynman_next(
    db: State<'_, Db>,
    conversation_id: String,
) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();

    let mut state = load_feynman_state(&db.conn(), &conversation_id)?
        .ok_or_else(|| "当前会话不是闯关模式".to_string())?;
    if state.status == StageStatus::Done {
        return Err("全部概念已讲完".to_string());
    }
    let cur_passed = state
        .current_concept_state()
        .map(|c| c.status == ConceptStatus::Passed)
        .unwrap_or(false);
    if !cur_passed {
        return Err("当前概念尚未通过测验".to_string());
    }
    if state.current_index + 1 >= state.plan.len() {
        state.status = StageStatus::Done;
        {
            let conn = db.conn();
            save_feynman_state(&conn, &conversation_id, &state)?;
        }
        return Ok(FeynmanTurn {
            conversation_id,
            reply: String::new(),
            state: Some(state),
        });
    }
    state.current_index += 1;
    if let Some(cs) = state.concepts.get_mut(state.current_index) {
        cs.status = ConceptStatus::Teaching;
    }

    // 锁内：读历史（无锁阶段再生成提问，避免持锁 await）
    let history: Vec<FeynmanMessage> = {
        let conn = db.conn();
        let messages_json: String = conn
            .query_row(
                "SELECT messages FROM conversations WHERE id = ?1",
                [&conversation_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("会话不存在: {e}"))?;
        serde_json::from_str(&messages_json).map_err(|e| e.to_string())?
    };

    let mut history = history;
    let reply =
        ask_concept_opening(&db, &llm, &conversation_id, &state, &mut history, now).await?;

    Ok(FeynmanTurn {
        conversation_id,
        reply,
        state: Some(state),
    })
}

/// 生成教学复盘：基于该会话历史（滚动摘要 + 最近窗口）评估讲解质量（不写回 messages）。
/// 长会话下复盘输入同样有上界；若摘要尚未覆盖滑出历史，先在线压缩一次再复盘。
/// 闯关会话会附带「当前关卡」状态块（概念与教学目标）供按概念点评。
#[tauri::command]
pub async fn feynman_review(
    db: State<'_, Db>,
    conversation_id: String,
) -> Result<String, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    let (history, summary, state): (Vec<FeynmanMessage>, Option<String>, Option<FeynmanState>) = {
        let conn = db.conn();
        let (messages_json, summary, state_raw): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT messages, summary, feynman_state FROM conversations WHERE id = ?1",
                [&conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| format!("会话不存在: {e}"))?;
        (
            serde_json::from_str(&messages_json).map_err(|e| e.to_string())?,
            summary,
            parse_state_json(state_raw)?,
        )
    };

    let (overflow, window) =
        crate::feynman::split_window(&history, crate::feynman::WINDOW_MAX_MSGS);
    // 有滑出历史则把当前 overflow 并入摘要，保证复盘覆盖全量进展（在线一次）
    let summary = if overflow.is_empty() {
        summary
    } else {
        Some(
            crate::feynman::roll_summary(&llm, summary.as_deref(), &overflow)
                .await
                .map_err(|e| e.to_string())?,
        )
    };

    let state_note = match state.as_ref() {
        Some(st) => crate::feynman::build_stage_note(st),
        None => String::new(),
    };
    crate::feynman::review(&llm, summary.as_deref(), &state_note, &window)
        .await
        .map_err(|e| e.to_string())
}

/// 取某篇论文最近的费曼会话（供前端恢复进度；无则返回 None）。
#[tauri::command]
pub fn get_feynman_conversation(
    db: State<'_, Db>,
    paper_id: String,
) -> Result<Option<Conversation>, String> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, paper_id, type, title, messages, created_at, updated_at, notes, summary, feynman_state \
         FROM conversations WHERE paper_id = ?1 AND type = 'feynman' \
         ORDER BY updated_at DESC LIMIT 1",
        [&paper_id],
        |r| {
            Ok(Conversation {
                id: r.get(0)?,
                paper_id: r.get(1)?,
                conv_type: r.get(2)?,
                title: r.get(3)?,
                messages: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                notes: r.get(7)?,
                summary: r.get(8)?,
                feynman_state: r.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
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

    #[test]
    fn annotations_roundtrip() {
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

        // 初始无标注
        assert_eq!(get_annotations_inner(&db, &paper.id).unwrap(), None);

        // 保存后可读回，且落在论文目录下
        let data = r#"{"version":1,"highlights":[{"id":"h1","page_idx":0,"rects":[{"x":0.1,"y":0.2,"w":0.4,"h":0.015}],"color":"rgba(255,213,0,.45)","text":"hello","note":null,"created_at":1712000000}]}"#;
        save_annotations_inner(&db, &paper.id, data).unwrap();
        let back = get_annotations_inner(&db, &paper.id).unwrap().unwrap();
        assert_eq!(back, data);
        let file = library
            .join(&paper.id)
            .join("annotations.json");
        assert!(file.exists(), "annotations.json 应写入论文目录");

        fs::remove_dir_all(&tmp).ok();
    }

    // ---------- 论文整理（虚拟文件夹） ----------

    /// 测试夹具：内存库 + 两篇论文。
    fn folder_test_setup() -> (Db, std::path::PathBuf, Vec<String>) {
        db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::migrate(&conn).unwrap();
        let db = db::Db::from_connection(conn);

        let tmp = std::env::temp_dir().join(format!("zoompaper-test-{}", uuid::Uuid::new_v4()));
        let library = tmp.join("papers");
        fs::create_dir_all(&library).unwrap();
        let mut ids = Vec::new();
        for i in 0..2 {
            let src = tmp.join(format!("src-{i}.pdf"));
            fs::write(&src, b"%PDF-1.4 test").unwrap();
            let paper = import_pdf_inner(&db, &library, src.to_str().unwrap()).unwrap();
            ids.push(paper.id);
        }
        (db, tmp, ids)
    }

    #[test]
    fn folder_crud_and_sibling_name_check() {
        let (db, tmp, _ids) = folder_test_setup();

        // 新建顶级文件夹（含颜色与标签）
        let root = create_folder_inner(
            &db,
            "AI",
            None,
            Some("blue".into()),
            Some(vec!["深度学习".into(), "2024".into()]),
        )
        .unwrap();
        assert_eq!(root.color, "blue");
        assert_eq!(root.tags, vec!["深度学习", "2024"]);

        // 子文件夹
        let child = create_folder_inner(
            &db,
            "Transformer",
            Some(root.id.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(root.id.as_str()));

        // 同级重名拒绝；不同父级允许
        assert!(create_folder_inner(&db, "AI", None, None, None).is_err());
        assert!(create_folder_inner(&db, "AI", Some(child.id.clone()), None, None).is_ok());

        // 重命名 + 改色 + 改标签
        let updated = update_folder_inner(
            &db,
            &root.id,
            Some("  LLM  ".into()),
            Some("purple".into()),
            Some(vec!["大模型".into()]),
        )
        .unwrap();
        assert_eq!(updated.name, "LLM");
        assert_eq!(updated.color, "purple");
        assert_eq!(updated.tags, vec!["大模型"]);

        // 空名拒绝
        assert!(update_folder_inner(&db, &root.id, Some("   ".into()), None, None).is_err());

        // 删除文件夹：子文件夹上移一级（顶级）
        delete_folder_inner(&db, &root.id).unwrap();
        let folders = list_folders_inner(&db).unwrap();
        let child_now = folders.iter().find(|f| f.id == child.id).unwrap();
        assert_eq!(child_now.parent_id, None, "子文件夹应上移为顶级");
        assert_eq!(folders.len(), 2, "剩两个顶级文件夹（AI 的后代重名文件夹 + 上移的 Transformer）");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn paper_membership_and_aggregation() {
        let (db, tmp, ids) = folder_test_setup();
        let a = create_folder_inner(&db, "AI", None, None, None).unwrap();
        let b = create_folder_inner(&db, "CV", None, None, None).unwrap();

        // 多归属：论文 0 同时进 AI + CV；论文 1 只进 AI
        assert_eq!(
            add_papers_to_folder_inner(&db, &[ids[0].clone()], &a.id).unwrap(),
            1
        );
        assert_eq!(
            add_papers_to_folder_inner(&db, &[ids[0].clone()], &b.id).unwrap(),
            1
        );
        assert_eq!(
            add_papers_to_folder_inner(&db, &[ids[1].clone()], &a.id).unwrap(),
            1
        );
        // 幂等：重复加入为 no-op
        assert_eq!(
            add_papers_to_folder_inner(&db, &[ids[0].clone()], &a.id).unwrap(),
            0
        );

        // list_papers 聚合出 folder_ids
        let papers = list_papers_inner(&db).unwrap();
        let p0 = papers.iter().find(|p| p.id == ids[0]).unwrap();
        let p1 = papers.iter().find(|p| p.id == ids[1]).unwrap();
        assert_eq!(p0.folder_ids.len(), 2);
        assert!(p0.folder_ids.contains(&a.id) && p0.folder_ids.contains(&b.id));
        assert_eq!(p1.folder_ids, vec![a.id.clone()]);

        // get_paper 同样聚合
        let g0 = get_paper_inner(&db, &ids[0]).unwrap();
        assert_eq!(g0.folder_ids.len(), 2);

        // 移除：论文 0 从 CV 移除
        assert_eq!(
            remove_papers_from_folder_inner(&db, &[ids[0].clone()], &b.id).unwrap(),
            1
        );
        let papers = list_papers_inner(&db).unwrap();
        let p0 = papers.iter().find(|p| p.id == ids[0]).unwrap();
        assert_eq!(p0.folder_ids, vec![a.id.clone()]);

        // 删除文件夹：paper_folders 级联清空，论文行保留（变未分类）
        delete_folder_inner(&db, &a.id).unwrap();
        let papers = list_papers_inner(&db).unwrap();
        assert_eq!(papers.len(), 2, "删除文件夹不删论文");
        assert!(papers.iter().all(|p| p.folder_ids.is_empty()));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rename_paper_validates_and_persists() {
        let (db, tmp, ids) = folder_test_setup();
        assert!(rename_paper_inner(&db, &ids[0], "   ").is_err());
        assert!(rename_paper_inner(&db, "不存在", "x").is_err());

        let renamed = rename_paper_inner(&db, &ids[0], "  Attention Is All You Need  ").unwrap();
        assert_eq!(renamed.title, "Attention Is All You Need");
        let back = get_paper_inner(&db, &ids[0]).unwrap();
        assert_eq!(back.title, "Attention Is All You Need");

        fs::remove_dir_all(&tmp).ok();
    }
}
