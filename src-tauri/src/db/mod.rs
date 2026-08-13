//! 数据库连接管理与 sqlite-vec 注册。

pub mod migrations;
pub mod models;

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// 应用持有的数据库句柄（rusqlite Connection 非 Sync，用 Mutex 包一层）。
pub struct Db {
    conn: Mutex<Connection>,
}

/// 通过 sqlite3_auto_extension 把 sqlite-vec 静态链接进每个连接。
///
/// 必须在任何 Connection 打开之前注册一次；注册后所有新连接自动具备
/// vec0 虚拟表与 vec_* 函数。测试中也需要先注册，故为 pub(crate)。
pub(crate) fn register_sqlite_vec() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        unsafe {
            // sqlite3_vec_init 是 extern "C" fn()，而 auto_extension 期望 xEntryPoint
            // 签名，这是官方推荐的静态扩展注册方式。
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// 打开数据库并应用迁移。
pub fn open(db_path: &Path) -> Result<Connection> {
    register_sqlite_vec();
    let conn = Connection::open(db_path).context("打开数据库失败")?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .context("设置 WAL 失败")?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .context("启用外键失败")?;
    migrations::migrate(&conn)?;
    Ok(conn)
}

impl Db {
    /// 初始化数据库（建目录 + 打开 + 迁移）。
    pub fn init() -> Result<Self> {
        let dir = crate::settings::app_data_dir()?;
        std::fs::create_dir_all(&dir).context("创建数据目录失败")?;
        let conn = open(&dir.join("database.sqlite"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("数据库锁被毒化")
    }

    /// 用已有的连接构造 Db（测试用）。
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zerocopy::AsBytes;

    #[test]
    fn sqlite_vec_and_schema_work() {
        register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();

        // sqlite-vec 已注册
        let version: String = conn
            .query_row("select vec_version()", [], |r| r.get(0))
            .unwrap();
        assert!(!version.is_empty());

        // 迁移建表
        migrations::migrate(&conn).unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type IN ('table','view') \
                 AND name IN ('papers','paper_chunks','vec_chunks','conversations')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 4, "应建出 4 张表");

        // 向量可写入并可做 KNN 检索（384 维与表声明一致）
        let mut v = vec![0.0_f32; 384];
        v[0] = 1.0;
        conn.execute(
            "INSERT INTO vec_chunks (embedding, paper_id) VALUES (?, ?)",
            rusqlite::params![v.as_bytes(), "paper-1"],
        )
        .unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vec_chunks WHERE embedding MATCH ? AND k = 1",
                [v.as_bytes()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
