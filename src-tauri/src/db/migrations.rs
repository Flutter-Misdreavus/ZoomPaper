//! 数据库迁移：用 `PRAGMA user_version` 控制 schema 版本。
//!
//! 新增表或改表结构时，在 `MIGRATIONS` 追加一段 SQL 即可。

use anyhow::Result;
use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    // v1：初始 schema
    r#"
    CREATE TABLE IF NOT EXISTS papers (
        id            TEXT PRIMARY KEY,          -- UUID
        title         TEXT NOT NULL,
        authors       TEXT,                      -- JSON 数组
        abstract      TEXT,
        pdf_path      TEXT NOT NULL,
        md_path       TEXT NOT NULL,
        blog_md_path  TEXT,
        created_at    INTEGER,
        last_read_at  INTEGER,
        reading_status TEXT DEFAULT 'unread',
        parse_status  TEXT DEFAULT 'unparsed'    -- unparsed/parsing/ready/failed
    );

    CREATE TABLE IF NOT EXISTS paper_chunks (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id  TEXT REFERENCES papers(id),
        section   TEXT,                           -- abstract/intro/method/results/conclusion
        content   TEXT NOT NULL,
        start_line INTEGER,
        end_line   INTEGER
    );

    -- 向量表：维度与 embedding 模型绑定（bge-small-en-v1.5 = 384 维）
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding float[384],
        paper_id TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        paper_id   TEXT REFERENCES papers(id),
        type       TEXT CHECK(type IN ('qa', 'feynman')),
        title      TEXT,
        messages   TEXT NOT NULL,                -- JSON 数组
        created_at INTEGER,
        updated_at INTEGER
    );
    "#,
    // v2：paper_chunks 增加定位列（结构化分块用 content_list 的 page_idx / bbox）
    // 说明：start_line/end_line 语义改为 content_list 的块索引范围（不再是 md 行号）
    r#"
    ALTER TABLE paper_chunks ADD COLUMN page_idx INTEGER;
    ALTER TABLE paper_chunks ADD COLUMN bbox TEXT;
    "#,
];

/// 按版本顺序执行未应用的迁移。
pub fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", target)?;
        }
    }
    Ok(())
}
