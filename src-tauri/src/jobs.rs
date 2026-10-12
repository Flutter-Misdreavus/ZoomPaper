//! Durable per-stage jobs. Workers are owned by the application, never a page.
use crate::db::Db;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

/// 取消 index 任务后，等待不可中断的阻塞推理收尾的上限。
/// 超过该时间就放弃等待，宁可留下一个可能重叠的后台推理，
/// 也不能让任务行永远停在 running/canceling 而堵死 guard()。
const INDEX_DRAIN_CEILING: Duration = Duration::from_secs(30);

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS background_jobs (
 id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 batch_id TEXT, completed_pages INTEGER, total_pages INTEGER, error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_job ON background_jobs(paper_id,kind,revision)
 WHERE status IN ('queued','running','canceling');
CREATE INDEX IF NOT EXISTS job_queue ON background_jobs(kind,status,created_at);
CREATE TABLE IF NOT EXISTS browser_import_receipts (
 request_id TEXT PRIMARY KEY, paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
 error TEXT, created_at INTEGER NOT NULL
);
"#;
#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub id: String,
    pub paper_id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub stage: String,
    pub batch_id: Option<String>,
    pub completed_pages: Option<u32>,
    pub total_pages: Option<u32>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        id: r.get(0)?,
        paper_id: r.get(1)?,
        title: r.get(2)?,
        kind: r.get(3)?,
        status: r.get(4)?,
        stage: r.get(5)?,
        batch_id: r.get(6)?,
        completed_pages: r.get(7)?,
        total_pages: r.get(8)?,
        error: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}
const SELECT:&str="SELECT j.id,j.paper_id,p.title,j.kind,j.status,j.stage,j.batch_id,j.completed_pages,j.total_pages,j.error,j.created_at,j.updated_at FROM background_jobs j JOIN papers p ON p.id=j.paper_id";
pub fn enqueue(db: &Db, paper_id: &str, kind: &str) -> Result<String, String> {
    let conn = db.conn();
    let revision: i64 = conn
        .query_row(
            "SELECT parse_revision FROM papers WHERE id=?1",
            [paper_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let visible: bool = conn
        .query_row(
            "SELECT deleted_at IS NULL FROM papers WHERE id=?1",
            [paper_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !visible {
        return Err("论文已在回收站".into());
    }
    if let Some(id)=conn.query_row("SELECT id FROM background_jobs WHERE paper_id=?1 AND kind=?2 AND (kind='parse' OR revision=?3) AND status IN ('queued','running','canceling')",params![paper_id,kind,revision],|r|r.get(0)).optional().map_err(|e|e.to_string())?{return Ok(id);}
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    conn.execute("INSERT INTO background_jobs(id,paper_id,kind,status,stage,created_at,updated_at,revision) VALUES(?1,?2,?3,'queued','queued',?4,?4,?5)",params![id,paper_id,kind,now,revision]).map_err(|e|e.to_string())?;
    Ok(id)
}
pub fn ensure(db: &Db, paper_id: &str, kind: &str) -> Result<String, String> {
    let previous:Option<String>=db.conn().query_row("SELECT id FROM background_jobs WHERE paper_id=?1 AND kind=?2 ORDER BY created_at DESC LIMIT 1",params![paper_id,kind],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    match previous {
        Some(id) => Ok(id),
        None => enqueue(db, paper_id, kind),
    }
}
#[tauri::command]
pub fn list_jobs(db: State<'_, Db>) -> Result<Vec<Job>, String> {
    snapshot(&db)
}
pub fn snapshot(db: &Db) -> Result<Vec<Job>, String> {
    let conn = db.conn();
    let mut stmt=conn.prepare(&format!("{SELECT} WHERE p.deleted_at IS NULL AND (j.status IN ('queued','running','canceling') OR j.id IN (SELECT id FROM background_jobs WHERE status NOT IN ('queued','running','canceling') ORDER BY updated_at DESC LIMIT 50)) ORDER BY CASE j.status WHEN 'canceling' THEN 0 WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,j.updated_at DESC")).map_err(|e|e.to_string())?;
    let rows = stmt.query_map([], row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn cancel_job(db: State<'_, Db>, job_id: String) -> Result<(), String> {
    cancel(&db, &job_id)
}
fn cancel(db: &Db, id: &str) -> Result<(), String> {
    db.conn().execute("UPDATE background_jobs SET status=CASE status WHEN 'running' THEN 'canceling' ELSE 'canceled' END,error=NULL,updated_at=?2 WHERE id=?1 AND status IN ('queued','running')",params![id,chrono::Utc::now().timestamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn retry_job(db: State<'_, Db>, job_id: String) -> Result<(), String> {
    retry(&db, &job_id)
}
fn retry(db: &Db, id: &str) -> Result<(), String> {
    let job = snapshot(db)?
        .into_iter()
        .find(|j| j.id == id)
        .ok_or("任务不存在")?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err("任务无需重试".into());
    }
    let conn = db.conn();
    let active:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM background_jobs WHERE paper_id=?1 AND kind=?2 AND status IN ('queued','running','canceling'))",params![job.paper_id,job.kind],|r|r.get(0)).map_err(|e|e.to_string())?;
    if active {
        return Err("已有同类任务正在处理".into());
    }
    conn.execute("UPDATE background_jobs SET status='queued',stage='queued',error=NULL,updated_at=?2,revision=(SELECT parse_revision FROM papers WHERE id=background_jobs.paper_id) WHERE id=?1",params![id,chrono::Utc::now().timestamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn claim(db: &Db, kind: &str) -> Result<Option<Job>, String> {
    let limit = crate::settings::Settings::load()
        .map(|s| s.workflow.parse_concurrency)
        .unwrap_or(2)
        .max(1);
    claim_with_limit(db, kind, limit)
}
fn claim_with_limit(db: &Db, kind: &str, limit: u32) -> Result<Option<Job>, String> {
    if crate::storage::MAINTENANCE.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let conn = db.conn();
    if crate::storage::MAINTENANCE.load(Ordering::SeqCst) {
        return Ok(None);
    }
    if kind == "parse" {
        let running:u32=conn.query_row("SELECT count(*) FROM background_jobs WHERE kind='parse' AND status IN ('running','canceling')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if running >= limit {
            return Ok(None);
        }
    }
    let id:Option<String>=conn.query_row("SELECT j.id FROM background_jobs j JOIN papers p ON p.id=j.paper_id WHERE j.kind=?1 AND j.status='queued' AND p.deleted_at IS NULL ORDER BY j.created_at LIMIT 1",[kind],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(id) = id else { return Ok(None) };
    conn.execute(
        "UPDATE background_jobs SET status='running',updated_at=?2 WHERE id=?1",
        params![id, chrono::Utc::now().timestamp()],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(&format!("{SELECT} WHERE j.id=?1"), [id], row)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn active(db: &Db, id: &str) -> bool {
    db.conn().query_row("SELECT j.status='running' AND p.deleted_at IS NULL FROM background_jobs j JOIN papers p ON p.id=j.paper_id WHERE j.id=?1",[id],|r|r.get(0)).unwrap_or(false)
}
fn progress(db: &Db, id: &str, p: crate::ai::mineru::ParseProgress) {
    let _=db.conn().execute("UPDATE background_jobs SET stage=?2,completed_pages=?3,total_pages=?4,updated_at=?5 WHERE id=?1 AND status='running'",params![id,p.stage,p.extracted_pages,p.total_pages,chrono::Utc::now().timestamp()]);
}
pub fn start(app: AppHandle) {
    // Restart interrupted workers. Persisted batch IDs allow resuming cloud polling.
    let _ = app.state::<Db>().conn().execute(
        "UPDATE background_jobs SET status='queued',stage='queued' WHERE status='running'",
        [],
    );
    let _ = app.state::<Db>().conn().execute(
        "UPDATE background_jobs SET status='canceled' WHERE status='canceling'",
        [],
    );
    // Recover missing follow-up jobs if the app closed between parse completion and enqueue.
    for kind in ["index", "translate", "doi"] {
        if !follow_up_enabled(kind) {
            continue;
        }
        let _=app.state::<Db>().conn().execute("INSERT INTO background_jobs(id,paper_id,kind,status,stage,created_at,updated_at,revision) SELECT lower(hex(randomblob(16))),j.paper_id,?1,'queued','queued',?2,?2,p.parse_revision FROM background_jobs j JOIN papers p ON p.id=j.paper_id WHERE j.kind='parse' AND j.status='done' AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM background_jobs next WHERE next.paper_id=j.paper_id AND next.kind=?1 AND next.revision=p.parse_revision) GROUP BY j.paper_id", params![kind,chrono::Utc::now().timestamp()]);
    }

    let parser = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(Some(job)) = claim(&parser.state::<Db>(), "parse") {
                let owner = parser.clone();
                tauri::async_runtime::spawn(async move {
                    run(&owner, &job).await;
                });
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    });
    for kind in ["index", "translate", "doi"] {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if let Ok(Some(job)) = claim(&app.state::<Db>(), kind) {
                    run(&app, &job).await;
                } else {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        });
    }
}

/// 取消后等待「不可中断的阻塞推理」收尾，最多等 `ceiling`。
///
/// 返回 `true` 表示 future 已在期限内跑完（可以安全丢弃结果）；
/// 返回 `false` 表示已超时放弃等待——此时调用方必须 detach 而不是继续
/// `await`，否则任务会永远停在 `running`/`canceling`，进而让 `guard()`
/// 永久拒绝备份/恢复/迁移。
async fn drain_or_detach<F, S>(future: Pin<&mut F>, shutdown: S, ceiling: Duration) -> bool
where
    F: Future,
    S: Future,
{
    tokio::pin!(shutdown);
    let sleep = tokio::time::sleep(ceiling);
    tokio::pin!(sleep);
    tokio::select! {
        _ = future => true,
        _ = &mut shutdown => false,
        _ = &mut sleep => false,
    }
}

async fn run(app: &AppHandle, job: &Job) {
    let db = app.state::<Db>();
    let canceled = Arc::new(AtomicBool::new(false));
    let flag = canceled.clone();
    let work = async {
        match job.kind.as_str() {
            "parse" => {
                crate::commands::parse_background(
                    &db,
                    &job.paper_id,
                    &|p| progress(&db, &job.id, p),
                    job.batch_id.as_deref(),
                    &|id| {
                        db.conn()
                            .execute(
                                "UPDATE background_jobs SET batch_id=?2,updated_at=?3 WHERE id=?1",
                                params![job.id, id, chrono::Utc::now().timestamp()],
                            )
                            .map_err(|e| e.to_string())?;
                        Ok(())
                    },
                )
                .await
            }
            "index" => {
                // A blocking model inference cannot be forcibly terminated. Wait for it even after cancel,
                // but do not commit its results, preventing another job from overlapping it.
                let result = crate::commands::index_background(&db, &job.paper_id, flag).await;
                result.map(|_| ())
            }
            "translate" => crate::commands::translate_paper_metadata_inner(&db, &job.paper_id)
                .await
                .map(|_| ()),
            "doi" => crate::commands::refresh_publication_inner(&db, &job.paper_id).await,
            _ => Err("未知任务类型".into()),
        }
    };
    tokio::pin!(work);
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(if job.kind == "parse" {
        1800
    } else {
        180
    }));
    tokio::pin!(timeout);
    let result = loop {
        tokio::select! {
         r=&mut work=>break r,
         _=&mut timeout=>{
          canceled.store(true,Ordering::Relaxed);
          // 阻塞推理无法强制中断：给它一个有限的收尾窗口，超时则放弃等待、
          // 直接进入失败终态，避免任务与 guard() 被永久卡住。
          if job.kind=="index"{
           drain_or_detach(work.as_mut(), tokio::time::sleep(INDEX_DRAIN_CEILING), INDEX_DRAIN_CEILING).await;
          }
          break Err("任务等待超时，可重试".into());
         },
         _=tokio::time::sleep(std::time::Duration::from_millis(350))=>{
          if !active(&db,&job.id){
           canceled.store(true,Ordering::Relaxed);
           if job.kind=="index"{
            drain_or_detach(work.as_mut(), tokio::time::sleep(INDEX_DRAIN_CEILING), INDEX_DRAIN_CEILING).await;
           }
           let _=db.conn().execute("UPDATE background_jobs SET status='canceled' WHERE id=?1",[&job.id]);
           return;
          }
         }
        }
    };
    // Dropping parse work executes its failure guard. Post-processing errors never undo ready PDF.
    drop(work);
    let now = chrono::Utc::now().timestamp();
    let (status, error) = match result {
        Ok(()) => ("done", None),
        Err(e) => ("failed", Some(e)),
    };
    let completed=db.conn().execute("UPDATE background_jobs SET status=?2,error=?3,updated_at=?4,batch_id=CASE WHEN ?3 LIKE '%MinerU 解析失败:%' THEN NULL ELSE batch_id END WHERE id=?1 AND status='running'",params![job.id,status,error,now]).unwrap_or(0);
    let _ = db.conn().execute(
        "UPDATE background_jobs SET status='canceled' WHERE id=?1 AND status='canceling'",
        [&job.id],
    );
    if completed == 1 && status == "done" && job.kind == "parse" {
        for kind in ["index", "translate", "doi", "full_translation"] {
            if !follow_up_enabled(kind) {
                continue;
            }
            let _ = enqueue(&db, &job.paper_id, kind);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Db {
        crate::db::register_sqlite_vec();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn).unwrap();
        conn.execute("INSERT INTO papers(id,title,pdf_path,md_path)VALUES('a','A','a.pdf','a.md'),('b','B','b.pdf','b.md')",[]).unwrap();
        Db::from_connection(conn)
    }
    #[test]
    fn queue_deduplicates_and_accepts_other_papers() {
        let db = database();
        let a = enqueue(&db, "a", "parse").unwrap();
        assert_eq!(enqueue(&db, "a", "parse").unwrap(), a);
        enqueue(&db, "b", "parse").unwrap();
        assert_eq!(snapshot(&db).unwrap().len(), 2);
        assert_eq!(claim(&db, "parse").unwrap().unwrap().paper_id, "a");
        assert_eq!(claim(&db, "parse").unwrap().unwrap().paper_id, "b");
        assert!(claim(&db, "parse").unwrap().is_none());
    }
    #[test]
    fn stages_cancel_and_retry_independently() {
        let db = database();
        let parse = enqueue(&db, "a", "parse").unwrap();
        let doi = enqueue(&db, "a", "doi").unwrap();
        cancel(&db, &doi).unwrap();
        assert_eq!(
            snapshot(&db)
                .unwrap()
                .iter()
                .find(|j| j.id == parse)
                .unwrap()
                .status,
            "queued"
        );
        retry(&db, &doi).unwrap();
        assert_eq!(
            snapshot(&db)
                .unwrap()
                .iter()
                .find(|j| j.id == doi)
                .unwrap()
                .status,
            "queued"
        );
    }
    #[test]
    fn running_cancel_blocks_retry_until_worker_stops() {
        let db = database();
        let id = enqueue(&db, "a", "parse").unwrap();
        claim(&db, "parse").unwrap();
        cancel(&db, &id).unwrap();
        assert!(!active(&db, &id));
        assert_eq!(snapshot(&db).unwrap()[0].status, "canceling");
        assert!(retry(&db, &id).is_err());
        assert_eq!(enqueue(&db, "a", "parse").unwrap(), id);
        db.conn()
            .execute(
                "UPDATE background_jobs SET status='canceled' WHERE id=?1",
                [&id],
            )
            .unwrap();
        retry(&db, &id).unwrap();
        assert_eq!(snapshot(&db).unwrap()[0].status, "queued");
    }
    /// index 的阻塞推理远超上限时，drain 必须超时返回，而不是无限等待——
    /// 否则任务会永远停在 running/canceling，guard() 会一直拒绝数据操作。
    #[tokio::test]
    async fn drain_returns_after_ceiling_when_work_never_finishes() {
        let ceiling = Duration::from_millis(40);
        let started = std::time::Instant::now();
        let pending = std::future::pending::<()>();
        tokio::pin!(pending);
        let completed = drain_or_detach(
            pending.as_mut(),
            tokio::time::sleep(Duration::from_secs(30)),
            ceiling,
        )
        .await;
        assert!(!completed, "pending work should not report completion");
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(5), "drain took {elapsed:?}");
    }

    /// 收尾迅速完成时应返回 true（正常丢弃结果，不触发超时）。
    #[tokio::test]
    async fn drain_reports_completion_when_work_finishes_quickly() {
        let work = async {};
        tokio::pin!(work);
        let completed = drain_or_detach(
            work.as_mut(),
            tokio::time::sleep(Duration::from_secs(30)),
            Duration::from_secs(30),
        )
        .await;
        assert!(completed);
    }

    /// 运行中的全文翻译被取消后，前端收尾必须还是终态，
    /// 否则任务永远停在 canceling，备份/恢复会被一直拒绝。
    #[test]
    fn canceling_frontend_translation_reaches_terminal_state() {
        let db = database();
        let id = enqueue(&db, "a", "full_translation").unwrap();
        // 模拟前端已 claim，然后用户点了「取消」
        db.conn()
            .execute(
                "UPDATE background_jobs SET status='running' WHERE id=?1",
                [&id],
            )
            .unwrap();
        cancel(&db, &id).unwrap();
        assert_eq!(snapshot(&db).unwrap()[0].status, "canceling");
        finish_status(&db, &id, None);
        let job = snapshot(&db).unwrap().into_iter().find(|j| j.id == id).unwrap();
        assert_eq!(job.status, "canceled");
        assert!(
            !matches!(job.status.as_str(), "running" | "canceling"),
            "收尾后不能仍是活动状态"
        );
    }

    #[test]
    fn cloud_batch_survives_restart() {
        let db = database();
        enqueue(&db, "a", "parse").unwrap();
        let j = claim(&db, "parse").unwrap().unwrap();
        db.conn()
            .execute(
                "UPDATE background_jobs SET batch_id='batch-123' WHERE id=?1",
                [j.id],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE background_jobs SET status='queued' WHERE status='running'",
                [],
            )
            .unwrap();
        assert_eq!(
            claim(&db, "parse").unwrap().unwrap().batch_id.as_deref(),
            Some("batch-123")
        );
    }
}

fn follow_up_enabled(kind: &str) -> bool {
    let w = crate::settings::Settings::load()
        .unwrap_or_default()
        .workflow;
    match kind {
        "doi" => w.auto_doi,
        "translate" => w.auto_metadata_translation,
        "full_translation" => w.auto_full_translation,
        _ => true,
    }
}
#[cfg(test)]
mod concurrency_tests {
    use super::*;
    #[test]
    fn changing_limit_never_interrupts_running_jobs() {
        crate::db::register_sqlite_vec();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn).unwrap();
        conn.execute("INSERT INTO papers(id,title,pdf_path,md_path)VALUES('a','A','a.pdf','a.md'),('b','B','b.pdf','b.md')",[]).unwrap();
        let db = Db::from_connection(conn);
        enqueue(&db, "a", "parse").unwrap();
        enqueue(&db, "b", "parse").unwrap();
        assert!(claim_with_limit(&db, "parse", 1).unwrap().is_some());
        assert!(claim_with_limit(&db, "parse", 1).unwrap().is_none());
        assert!(claim_with_limit(&db, "parse", 2).unwrap().is_some());
        assert!(claim_with_limit(&db, "parse", 1).unwrap().is_none());
        assert_eq!(
            snapshot(&db)
                .unwrap()
                .iter()
                .filter(|j| j.status == "running")
                .count(),
            2
        );
    }
}

#[tauri::command]
pub fn claim_frontend_translation(db: State<'_, Db>, job_id: String) -> Result<bool, String> {
    if crate::storage::MAINTENANCE.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let conn = db.conn();
    if crate::storage::MAINTENANCE.load(Ordering::SeqCst) { return Ok(false); }
    let changed=conn.execute("UPDATE background_jobs SET status='running',stage='translate',updated_at=?2 WHERE id=?1 AND kind='full_translation' AND status='queued'",params![job_id,chrono::Utc::now().timestamp()]).map_err(|e|e.to_string())?;
    Ok(changed == 1)
}
fn finish_status(db: &Db, job_id: &str, error: Option<String>) {
    // 用户可能在翻译进行中取消：此时行是 canceling，若只接受 running，
    // 收尾会变成 no-op，任务会永远停在 canceling 并让备份/恢复被一直拒绝。
    let state = if error.is_some() { "failed" } else { "done" };
    let _ = db.conn().execute(
        "UPDATE background_jobs SET status=CASE WHEN status='canceling' THEN 'canceled' ELSE ?2 END,error=?3,updated_at=?4 WHERE id=?1 AND kind='full_translation' AND status IN ('running','canceling')",
        params![job_id, state, error, chrono::Utc::now().timestamp()],
    );
}
#[tauri::command]
pub fn finish_frontend_translation(
    db: State<'_, Db>,
    job_id: String,
    error: Option<String>,
) -> Result<(), String> {
    finish_status(&db, &job_id, error);
    Ok(())
}
