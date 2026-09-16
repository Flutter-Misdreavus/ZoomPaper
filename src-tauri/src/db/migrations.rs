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
    // v8：agent 深度研究会话状态。
    // agent_state：进行中的 agent 运行现场 JSON（ask_user 澄清中断时保存，供 ask_question_reply 续跑）；
    // agent_memory：研究记忆条目数组 JSON（跨轮复用已查证来源的定位索引）。
    r#"
    ALTER TABLE conversations ADD COLUMN agent_state TEXT;
    ALTER TABLE conversations ADD COLUMN agent_memory TEXT;
    "#,
    // v9：论文库工作台 —— 星标字段（阅读状态 reading_status 自 v1 已有）。
    // 布尔用 INTEGER 0/1 存储；存量论文默认未星标。
    r#"
    ALTER TABLE papers ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
    "#,
    // v10：阅读时间线 —— 阅读会话（按天统计时长/读了哪些论文的粒度来源）、
    // papers.finished_at（最近一次标记已读时间，取消已读时清 NULL）、阅读计划表。
    // 每篇累计时长由 reading_sessions 聚合得出，不在 papers 上加冗余列。
    r#"
    CREATE TABLE IF NOT EXISTS reading_sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,        -- epoch 秒（该段阅读的开始时间）
        seconds    INTEGER NOT NULL         -- 该段时长
    );
    CREATE INDEX IF NOT EXISTS idx_reading_sessions_paper ON reading_sessions(paper_id);
    CREATE INDEX IF NOT EXISTS idx_reading_sessions_time  ON reading_sessions(started_at);

    ALTER TABLE papers ADD COLUMN finished_at INTEGER;

    CREATE TABLE IF NOT EXISTS reading_plans (
        id           TEXT PRIMARY KEY,          -- UUID
        type         TEXT NOT NULL CHECK(type IN ('daily', 'papers')),
        target_count INTEGER,                   -- type='daily'：每天读完 N 篇
        paper_ids    TEXT,                      -- type='papers'：JSON 数组，指派的论文 id
        deadline     INTEGER,                   -- type='papers'：截止日期（epoch 秒）
        created_at   INTEGER NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1 -- 完成/停用后置 0
    );
    "#,
    // v11：计划条目表 —— 指派论文从「计划级 paper_ids JSON + 单一 deadline」
    // 演进为「条目级 due date」（参考提醒事项：每条目各自定日期）。
    // 存量 paper_ids JSON 用 json_each 搬运进条目表，due 取计划原 deadline。
    // reading_plans.paper_ids / deadline 旧列保留但不再写入（向后兼容）。
    r#"
    CREATE TABLE IF NOT EXISTS reading_plan_items (
        plan_id    TEXT NOT NULL REFERENCES reading_plans(id) ON DELETE CASCADE,
        paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        due_date   INTEGER,               -- 条目级截止（epoch 秒）；NULL = 无日期
        created_at INTEGER NOT NULL,
        PRIMARY KEY (plan_id, paper_id)
    );
    CREATE INDEX IF NOT EXISTS idx_plan_items_paper ON reading_plan_items(paper_id);

    INSERT INTO reading_plan_items (plan_id, paper_id, due_date, created_at)
    SELECT rp.id, je.value, rp.deadline, rp.created_at
    FROM reading_plans rp, json_each(rp.paper_ids) je
    WHERE rp.type = 'papers' AND rp.paper_ids IS NOT NULL;
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
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 11);

        // 论文数据无损
        let title: String = conn
            .query_row("SELECT title FROM papers WHERE id = 'paper-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Attention Is All You Need");

        // v9：papers 已含 starred 列（存量论文默认未星标）
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(papers)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.contains(&"starred".to_string()));
        let starred: i64 = conn
            .query_row("SELECT starred FROM papers WHERE id = 'paper-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(starred, 0);

        // v10：papers 已含 finished_at 列；reading_sessions / reading_plans 新表可用
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(papers)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.contains(&"finished_at".to_string()));
        conn.execute(
            "INSERT INTO reading_sessions (paper_id, started_at, seconds) VALUES ('paper-1', 1700000003, 120)",
            [],
        )
        .unwrap();
        let secs: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(seconds), 0) FROM reading_sessions WHERE paper_id = 'paper-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(secs, 120);
        conn.execute(
            "INSERT INTO reading_plans (id, type, target_count, created_at) \
             VALUES ('plan-1', 'daily', 2, 1700000004)",
            [],
        )
        .unwrap();

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
        assert!(cols.contains(&"agent_state".to_string())); // v8
        assert!(cols.contains(&"agent_memory".to_string())); // v8
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

    /// v10 → v11：存量计划的 paper_ids JSON + 计划级 deadline 搬运为条目级 due date。
    #[test]
    fn v10_plans_migrate_to_items_with_plan_deadline() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // 手工执行 v1..v10，造一个 v10 库
        for sql in &MIGRATIONS[..10] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 10).unwrap();

        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path, created_at) \
             VALUES ('p1', 'A', '/a.pdf', '/a.md', 1700000000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path, created_at) \
             VALUES ('p2', 'B', '/b.pdf', '/b.md', 1700000000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO reading_plans (id, type, paper_ids, deadline, created_at) \
             VALUES ('plan-1', 'papers', '[\"p1\",\"p2\"]', 1700100000, 1700000001)",
            [],
        )
        .unwrap();
        // daily 计划无 paper_ids，不应产生条目
        conn.execute(
            "INSERT INTO reading_plans (id, type, target_count, created_at) \
             VALUES ('plan-2', 'daily', 2, 1700000002)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 11);

        let items: Vec<(String, Option<i64>)> = conn
            .prepare(
                "SELECT paper_id, due_date FROM reading_plan_items WHERE plan_id = 'plan-1' ORDER BY paper_id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            items,
            vec![("p1".to_string(), Some(1700100000)), ("p2".to_string(), Some(1700100000))],
            "存量条目应继承计划级 deadline"
        );
        let daily_items: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM reading_plan_items WHERE plan_id = 'plan-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(daily_items, 0);
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
