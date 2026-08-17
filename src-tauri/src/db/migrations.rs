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
    // v3：conversations 增加 notes 列（费曼会话首轮通读全文生成的要点笔记）
    r#"
    ALTER TABLE conversations ADD COLUMN notes TEXT;
    "#,
    // v4：conversations 增加 summary 列（费曼会话滚动「教学进展」摘要，控长对话 token）
    r#"
    ALTER TABLE conversations ADD COLUMN summary TEXT;
    "#,
    // v5：论文整理 —— 虚拟文件夹（多归属集合式）+ paper_folders 多对多中间表。
    // 磁盘文件保持扁平 {uuid}/ 结构不动；folders 仅存在于库内。
    r#"
    CREATE TABLE IF NOT EXISTS folders (
        id         TEXT PRIMARY KEY,            -- UUID
        name       TEXT NOT NULL,
        parent_id  TEXT REFERENCES folders(id) ON DELETE SET NULL,
        color      TEXT NOT NULL DEFAULT 'gray',  -- 色板 key（见前端 folderColors）
        tags       TEXT NOT NULL DEFAULT '[]',    -- JSON 字符串数组
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

    CREATE TABLE IF NOT EXISTS paper_folders (
        paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        folder_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (paper_id, folder_id)
    );
    CREATE INDEX IF NOT EXISTS idx_paper_folders_folder ON paper_folders(folder_id);
    "#,
    // v6：conversations 增加 feynman_state 列（费曼闯关状态 JSON：概念计划 / 当前关卡 / 各概念状态）。
    // 旧费曼会话该列为 NULL，前端据此走「自由聊天」遗留路径，不回归。
    r#"
    ALTER TABLE conversations ADD COLUMN feynman_state TEXT;
    "#,
    // v7：费曼「概念级独立会话」：concept_index 标记该行属于哪个概念的会话。
    // type='feynman' 且 concept_index IS NULL = 主行（存 feynman_state 进度元数据）；
    // concept_index = N = 概念 N 的独立会话行（消息/滚动摘要各自独立）。
    // 其他类型（qa）与旧版单会话费曼行该列为 NULL。
    r#"
    ALTER TABLE conversations ADD COLUMN concept_index INTEGER;
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    /// 存量库（v4）升级到最新版：papers 数据原样保留，新增 folders / paper_folders / feynman_state。
    #[test]
    fn v4_database_upgrades_to_v5_preserving_papers() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // 手工执行 v1..v4 的迁移，模拟存量库
        for sql in &MIGRATIONS[..4] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 4).unwrap();

        // 写入一篇存量论文
        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path, created_at) \
             VALUES ('paper-1', 'Attention Is All You Need', '/p/a.pdf', '/p/a.md', 1700000000)",
            [],
        )
        .unwrap();

        // 升级
        migrate(&conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 7);

        // 论文数据无损
        let title: String = conn
            .query_row("SELECT title FROM papers WHERE id = 'paper-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Attention Is All You Need");

        // 新表可用：插入文件夹 + 归属
        conn.execute(
            "INSERT INTO folders (id, name, parent_id, color, tags, created_at) \
             VALUES ('f-1', 'AI', NULL, 'blue', '[]', 1700000001)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO paper_folders (paper_id, folder_id, created_at) VALUES ('paper-1', 'f-1', 1700000002)",
            [],
        )
        .unwrap();
        let joined: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM paper_folders pf JOIN folders f ON f.id = pf.folder_id WHERE pf.paper_id = 'paper-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(joined, 1);

        // v6：conversations 已含 feynman_state 列（存量行为 None）
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(conversations)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.contains(&"feynman_state".to_string()));
        assert!(cols.contains(&"concept_index".to_string())); // v7
        let legacy_state: Option<String> = conn
            .query_row(
                "SELECT feynman_state FROM conversations WHERE id = 'paper-1'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert!(legacy_state.is_none());
    }

    /// 迁移幂等：重复执行不报错。
    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }
}
