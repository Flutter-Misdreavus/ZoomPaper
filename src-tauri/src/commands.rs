//! Tauri 命令层：前端通过 invoke 调用。

use crate::ai::llm::Role;
use crate::ai::mineru::MineruClient;
use crate::db::models::{Conversation, Paper, SearchHit};
use crate::feynman::{FeynmanMessage, FeynmanTurn};
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

/// 调用 LLM 生成博客，落盘 `blog.md` 并回写 `blog_md_path`。返回博客 Markdown 文本。
#[tauri::command]
pub async fn generate_blog(
    db: State<'_, Db>,
    paper_id: String,
    level: String,
) -> Result<String, String> {
    let level = crate::blog::BlogLevel::parse(&level).map_err(|e| e.to_string())?;
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

    // 生成（网络调用，await 期间不持有数据库锁）
    let blog = crate::blog::generate_blog(&llm, level, &markdown)
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

    // 检索 + 组装（同步，用完即释放数据库锁）
    let prepared = {
        let conn = db.conn();
        crate::qa::prepare(&conn, &question, paper_id.as_deref(), &history, top_k)
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
    let sql = "SELECT id, paper_id, type, title, messages, created_at, updated_at, notes \
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
        "SELECT id, paper_id, type, title, messages, created_at, updated_at, notes \
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
            })
        },
    )
    .map_err(|e| e.to_string())
}

// ---------- 费曼学习法 ----------

/// 开始费曼会话：通读全文生成要点笔记 + 学生开场白，并新建会话持久化。
/// 无需用户输入；返回开场白 + 要点笔记 + 新会话 id。
#[tauri::command]
pub async fn feynman_start(db: State<'_, Db>, paper_id: String) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = crate::ai::llm::Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().timestamp();

    // 锁内：读论文 md 路径（不建会话）
    let md_path: String = {
        let conn = db.conn();
        conn.query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [&paper_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };

    // 无锁：通读全文生成要点笔记
    let markdown = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
    let notes = crate::feynman::generate_digest(&llm, &markdown)
        .await
        .map_err(|e| e.to_string())?;

    // 无锁：生成学生开场白
    let opening = llm
        .chat(&crate::feynman::build_start_messages(&notes))
        .await
        .map_err(|e| e.to_string())?;

    // 锁内：新建会话并一次性写入 notes + 开场白消息
    let conv_id = Uuid::new_v4().to_string();
    let history = vec![FeynmanMessage {
        role: Role::Assistant,
        content: opening.clone(),
    }];
    let messages_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
    {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO conversations \
             (id, paper_id, type, title, messages, notes, created_at, updated_at) \
             VALUES (?1, ?2, 'feynman', '费曼学习', ?3, ?4, ?5, ?5)",
            params![&conv_id, &paper_id, &messages_json, &notes, now],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(FeynmanTurn {
        conversation_id: conv_id,
        reply: opening,
        notes: Some(notes),
    })
}

/// 一轮费曼对话：读/生成要点笔记 + 检索相关段落 + LLM 学生式回应，并持久化。
/// `conversation_id` 为 `Some` 时续接多轮；否则新建 `type='feynman'` 会话。
/// 要点笔记按会话存储（`conversations.notes`）：新会话首轮通读全文生成，后续轮次复用。
#[tauri::command]
pub async fn feynman_turn(
    db: State<'_, Db>,
    paper_id: String,
    message: String,
    conversation_id: Option<String>,
) -> Result<FeynmanTurn, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = crate::ai::llm::Llm::from_settings(&settings).map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().timestamp();
    let conv_id: String;
    let mut history: Vec<FeynmanMessage>;
    let mut notes: Option<String>;

    // 取/建会话，并读论文 md 路径 + 会话已有笔记
    let md_path: String;
    {
        let conn = db.conn();
        md_path = conn
            .query_row(
                "SELECT md_path FROM papers WHERE id = ?1",
                [&paper_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        match conversation_id {
            Some(id) => {
                let (messages_json, existing_notes): (String, Option<String>) = conn
                    .query_row(
                        "SELECT messages, notes FROM conversations WHERE id = ?1",
                        [&id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(|e| format!("会话不存在: {e}"))?;
                history = serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
                notes = existing_notes;
                conv_id = id;
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
                notes = None;
            }
        }
    }

    // 新会话首轮：通读全文并生成要点笔记（已有会话复用其笔记）
    let mut new_notes: Option<String> = None;
    if notes.is_none() {
        let markdown = crate::fs::read_md(Path::new(&md_path)).map_err(|e| e.to_string())?;
        let digest = crate::feynman::generate_digest(&llm, &markdown)
            .await
            .map_err(|e| e.to_string())?;
        notes = Some(digest.clone());
        new_notes = Some(digest);
    }

    // 检索相关段落 + 组装（同步，用完即释放数据库锁）；新生成笔记先写回
    let messages = {
        let conn = db.conn();
        if let Some(n) = &new_notes {
            conn.execute(
                "UPDATE conversations SET notes = ?2 WHERE id = ?1",
                params![&conv_id, n],
            )
            .map_err(|e| e.to_string())?;
        }
        let hits = crate::rag::search(&conn, &message, crate::feynman::TOP_K, Some(&paper_id))
            .map_err(|e| e.to_string())?;
        let context = crate::feynman::build_context(&hits);
        crate::feynman::build_turn_messages(
            notes.as_deref().unwrap_or(""),
            &context,
            &history,
            &message,
        )
    };

    // LLM（await 期间不持有数据库锁）
    let reply = crate::feynman::turn(&llm, &messages)
        .await
        .map_err(|e| e.to_string())?;

    // 追加 user + assistant 两条消息并写回
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
            "UPDATE conversations SET messages = ?2, updated_at = ?3 WHERE id = ?1",
            params![&conv_id, messages_json, now],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(FeynmanTurn {
        conversation_id: conv_id,
        reply,
        notes: new_notes,
    })
}

/// 生成教学复盘：基于该会话完整历史，评估讲解质量（不写回 messages）。
#[tauri::command]
pub async fn feynman_review(
    db: State<'_, Db>,
    conversation_id: String,
) -> Result<String, String> {
    let settings = Settings::load().map_err(|e| e.to_string())?;
    let llm = crate::ai::llm::Llm::from_settings(&settings).map_err(|e| e.to_string())?;

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

    crate::feynman::review(&llm, &history)
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
        "SELECT id, paper_id, type, title, messages, created_at, updated_at, notes \
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
}
