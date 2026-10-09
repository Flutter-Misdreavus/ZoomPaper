//! Offline snapshots preserve the live library; restoration is applied before workers start.
use crate::{db::Db, settings::Settings};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{Manager, State};
pub static MAINTENANCE: AtomicBool = AtomicBool::new(false);
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        MAINTENANCE.store(false, Ordering::SeqCst);
    }
}
fn guard(db: &Db) -> Result<Guard, String> {
    if MAINTENANCE.swap(true, Ordering::SeqCst) {
        return Err("已有数据操作正在进行".into());
    }
    let g = Guard;
    let running: bool = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM background_jobs WHERE status IN ('running','canceling'))",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if running {
        return Err("请等待正在运行的任务完成后操作".into());
    }
    Ok(g)
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    library: String,
    preferences: serde_json::Value,
}
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(from).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("数据目录不能包含符号链接".into());
    }
    if meta.is_dir() {
        fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(from, to).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn ids(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut q = conn
        .prepare("SELECT id FROM papers")
        .map_err(|e| e.to_string())?;
    let values = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for id in &values {
        if id.is_empty() || Path::new(id).components().count() != 1 || id == "." || id == ".." {
            return Err("论文目录无效".into());
        }
    }
    Ok(values)
}
fn snapshot(
    conn: &rusqlite::Connection,
    library: &Path,
    dest: &Path,
    preferences: serde_json::Value,
) -> Result<(), String> {
    fs::create_dir(dest).map_err(|e| e.to_string())?;
    let result = (|| {
        conn.execute(
            "VACUUM INTO ?1",
            [dest.join("database.sqlite").to_string_lossy().as_ref()],
        )
        .map_err(|e| e.to_string())?;
        fs::create_dir(dest.join("papers")).map_err(|e| e.to_string())?;
        for id in ids(conn)? {
            let source = library.join(&id);
            if source.exists() {
                copy_tree(&source, &dest.join("papers").join(id))?;
            }
        }
        fs::write(
            dest.join("manifest.json"),
            serde_json::to_vec(&Manifest {
                format: 1,
                library: library.to_string_lossy().into(),
                preferences,
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dest);
    }
    result
}
fn rewrite_paths(conn: &rusqlite::Connection, old: &Path, new: &Path) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id,pdf_path,md_path,blog_md_path FROM papers")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let map = |value: &str| -> Result<String, String> {
        if value.is_empty() {
            return Ok(String::new());
        }
        let rel = Path::new(value)
            .strip_prefix(old)
            .map_err(|_| "备份中的论文路径不属于原论文库".to_string())?;
        if rel
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
        {
            return Err("备份路径无效".into());
        }
        Ok(new.join(rel).to_string_lossy().into())
    };
    for (id, pdf, md, blog) in rows {
        conn.execute(
            "UPDATE papers SET pdf_path=?2,md_path=?3,blog_md_path=?4 WHERE id=?1",
            rusqlite::params![
                id,
                map(&pdf)?,
                map(&md)?,
                blog.as_deref().map(map).transpose()?
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn validate(dir: &Path) -> Result<Manifest, String> {
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if manifest.format != 1 {
        return Err("不支持的备份格式".into());
    }
    crate::db::register_sqlite_vec();
    let conn = rusqlite::Connection::open_with_flags(
        dir.join("database.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err("备份数据库校验失败".into());
    }
    for id in ids(&conn)? {
        let pdf: String = conn
            .query_row("SELECT pdf_path FROM papers WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let rel = Path::new(&pdf)
            .strip_prefix(&manifest.library)
            .map_err(|_| "备份路径无效".to_string())?;
        if rel
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
            || !dir.join("papers").join(rel).is_file()
        {
            return Err(format!("备份缺少论文文件：{id}"));
        }
    }
    Ok(manifest)
}
#[tauri::command]
pub async fn export_library_backup(
    app: tauri::AppHandle,
    destination: String,
    preferences: serde_json::Value,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let _g = guard(&db)?;
        let library = Settings::load()
            .map_err(|e| e.to_string())?
            .papers_dir()
            .map_err(|e| e.to_string())?;
        let root = PathBuf::from(destination);
        let canonical = root.canonicalize().map_err(|e| e.to_string())?;
        if canonical.starts_with(library.canonicalize().map_err(|e| e.to_string())?) {
            return Err("备份位置不能位于论文库内".into());
        }
        let target = root.join(format!("ZoomPaper-backup-{}", uuid::Uuid::new_v4()));
        snapshot(&db.conn(), &library, &target, preferences)?;
        Ok(target.to_string_lossy().into())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stage_library_restore(
    app: tauri::AppHandle,
    source: String,
    preferences: Option<serde_json::Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let _g = guard(&db)?;
        if !Path::new(&source).join("manifest.json").is_file() {
            return Err("请选择 ZoomPaper 导出的备份文件夹，目录中需包含 manifest.json".into());
        }
        validate(Path::new(&source)).map_err(|error| format!("备份格式无效或文件不完整：{error}"))?;
        let data = crate::settings::app_data_dir().map_err(|e| e.to_string())?;
        let stage = data.join(format!("restore-{}", uuid::Uuid::new_v4()));
        copy_tree(Path::new(&source), &stage)?;
        validate(&stage)?;
        fs::write(
            stage.join("before-preferences.json"),
            serde_json::to_vec(&preferences.unwrap_or(serde_json::Value::Null))
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        crate::fs::write_md(
            &data.join("restore-request.json"),
            &serde_json::to_string(&stage).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn apply_pending() -> anyhow::Result<()> {
    let data = crate::settings::app_data_dir()?;
    let request = data.join("restore-request.json");
    if !request.exists() {
        return Ok(());
    }
    let stage: PathBuf = serde_json::from_slice(&fs::read(&request)?)?;
    anyhow::ensure!(stage.parent() == Some(data.as_path()), "恢复目录无效");
    let m = validate(&stage).map_err(anyhow::Error::msg)?;
    let old_settings = Settings::load()?;
    let old_library = old_settings.papers_dir()?;
    let target = data.join(format!("restored-papers-{}", uuid::Uuid::new_v4()));
    copy_tree(&stage.join("papers"), &target).map_err(anyhow::Error::msg)?;
    let candidate = stage.join("candidate.sqlite");
    fs::copy(stage.join("database.sqlite"), &candidate)?;
    {
        let conn = crate::db::open(&candidate)?;
        rewrite_paths(&conn, Path::new(&m.library), &target).map_err(anyhow::Error::msg)?;
        conn.execute("UPDATE background_jobs SET status='canceled' WHERE status IN ('queued','running','canceling')",[])?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    }
    let recovery = data.join(format!("before-restore-{}", uuid::Uuid::new_v4()));
    let database = data.join("database.sqlite");
    if database.exists() {
        let conn = crate::db::open(&database)?;
        snapshot(
            &conn,
            &old_library,
            &recovery,
            serde_json::from_slice(&fs::read(stage.join("before-preferences.json"))?)
                .unwrap_or(serde_json::Value::Null),
        )
        .map_err(anyhow::Error::msg)?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    }
    let original = stage.join("original.sqlite");
    if database.exists() {
        fs::rename(&database, &original)?;
    }
    let mut updated = old_settings.clone();
    updated.paper_library_path = Some(target);
    let install = (|| -> anyhow::Result<()> {
        fs::rename(&candidate, &database)?;
        updated.save()?;
        Ok(())
    })();
    if let Err(e) = install {
        let _ = fs::remove_file(&database);
        if original.exists() {
            let _ = fs::rename(&original, &database);
        }
        let _ = old_settings.save();
        return Err(e);
    }
    crate::fs::write_md(
        &data.join("restored-preferences.json"),
        &serde_json::to_string(&m.preferences)?,
    )?;
    fs::remove_file(request)?;
    let _ = fs::remove_dir_all(stage);
    Ok(())
}
#[tauri::command]
pub fn take_restored_preferences() -> Result<Option<serde_json::Value>, String> {
    let data = crate::settings::app_data_dir().map_err(|e| e.to_string())?;
    let failed = data.join("restore-error.txt");
    if failed.exists() {
        let error = fs::read_to_string(&failed).map_err(|e| e.to_string())?;
        fs::remove_file(failed).map_err(|e| e.to_string())?;
        return Err(format!("恢复未完成，原论文库已保留：{error}"));
    }
    let path = data.join("restored-preferences.json");
    if !path.exists() {
        return Ok(None);
    }
    let value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(Some(value))
}
fn migration_root(destination: &Path, current: &Path) -> Result<PathBuf, String> {
    let root = destination.canonicalize().map_err(|_| "请选择有效的文件夹")?;
    if !root.is_dir() { return Err("请选择有效的文件夹".into()); }
    let current = current.canonicalize().map_err(|error|error.to_string())?;
    if root.starts_with(current) { return Err("请选择当前论文库之外的新文件夹".into()); }
    Ok(root)
}
#[tauri::command]
pub async fn relocate_library(
    app: tauri::AppHandle,
    destination: String,
) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let _g = guard(&db)?;
        let mut settings = Settings::load().map_err(|e| e.to_string())?;
        let old = settings.papers_dir().map_err(|e| e.to_string())?;
        let root = migration_root(Path::new(&destination), &old)?;
        let target = root.join(format!("ZoomPaper-library-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&target).map_err(|e| e.to_string())?;
        for id in ids(&db.conn())? {
            let source = old.join(&id);
            if source.exists() {
                copy_tree(&source, &target.join(id))?;
            }
        }
        let conn = db.conn();
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let original = settings.clone();
        let result = (|| {
            rewrite_paths(&conn, &old, &target)?;
            settings.paper_library_path = Some(target);
            settings.save().map_err(|e| e.to_string())?;
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(settings)
        })();
        if result.is_err() {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = original.save();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn clear_library_cache() -> Result<(), String> {
    let data = crate::settings::app_data_dir().map_err(|e| e.to_string())?;
    let cache = data.join("doi-cache");
    if cache.exists() {
        fs::remove_dir_all(cache).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn prepare_browser_extension() -> Result<String, String> {
    let dir = crate::settings::app_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser-extension");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, bytes) in [
        (
            "manifest.json",
            include_bytes!("../../browser-extension/manifest.json").as_slice(),
        ),
        (
            "background.js",
            include_bytes!("../../browser-extension/background.js").as_slice(),
        ),
        (
            "importer.js",
            include_bytes!("../../browser-extension/importer.js").as_slice(),
        ),
        (
            "scrape.js",
            include_bytes!("../../browser-extension/scrape.js").as_slice(),
        ),
        (
            "download.js",
            include_bytes!("../../browser-extension/download.js").as_slice(),
        ),
        (
            "detector.js",
            include_bytes!("../../browser-extension/detector.js").as_slice(),
        ),
        (
            "recovery.js",
            include_bytes!("../../browser-extension/recovery.js").as_slice(),
        ),
        (
            "recovery.html",
            include_bytes!("../../browser-extension/recovery.html").as_slice(),
        ),
        (
            "recovery.css",
            include_bytes!("../../browser-extension/recovery.css").as_slice(),
        ),
        (
            "icons/icon-16.png",
            include_bytes!("../../browser-extension/icons/icon-16.png").as_slice(),
        ),
        (
            "icons/icon-32.png",
            include_bytes!("../../browser-extension/icons/icon-32.png").as_slice(),
        ),
        (
            "icons/icon-48.png",
            include_bytes!("../../browser-extension/icons/icon-48.png").as_slice(),
        ),
        (
            "icons/icon-128.png",
            include_bytes!("../../browser-extension/icons/icon-128.png").as_slice(),
        ),
    ] {
        let file = dir.join(name);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(file, bytes).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("zoom-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn migration_refuses_nested_destinations_before_copying() {
        let root = std::env::temp_dir().join(format!("zoompaper-migration-{}",uuid::Uuid::new_v4()));
        let library = root.join("library");
        let nested = library.join("paper");
        let other = root.join("other");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&other).unwrap();
        assert!(migration_root(&nested,&library).is_err());
        assert!(migration_root(&library,&library).is_err());
        assert_eq!(migration_root(&other,&library).unwrap(),other.canonicalize().unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_preserves_papers_and_rewrites_paths_without_exporting_keys() {
        let root = temp();
        let library = root.join("library");
        let paper = library.join("p");
        fs::create_dir_all(&paper).unwrap();
        fs::write(paper.join("paper.pdf"), "%PDF-test").unwrap();
        fs::write(paper.join("translation.json"), "译文").unwrap();
        fs::write(library.join("settings.json"), "SECRET").unwrap();
        crate::db::register_sqlite_vec();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO papers(id,title,pdf_path,md_path) VALUES('p','Title',?1,?2)",
            rusqlite::params![
                paper.join("paper.pdf").to_str().unwrap(),
                paper.join("paper.md").to_str().unwrap()
            ],
        )
        .unwrap();
        let target = root.join("backup");
        snapshot(
            &conn,
            &library,
            &target,
            serde_json::json!({"zoompaper.preferences":"{}"}),
        )
        .unwrap();
        assert!(!target.join("papers/settings.json").exists());
        assert!(target.join("papers/p/translation.json").exists());
        assert_eq!(validate(&target).unwrap().format, 1);
        let backup = crate::db::open(&target.join("database.sqlite")).unwrap();
        rewrite_paths(&backup, &library, &root.join("new")).unwrap();
        let path: String = backup
            .query_row("SELECT pdf_path FROM papers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(path, root.join("new/p/paper.pdf").to_str().unwrap());
        drop(backup);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_missing_pdf_and_paths_outside_library() {
        let root = temp();
        let lib = root.join("papers");
        fs::create_dir(&lib).unwrap();
        crate::db::register_sqlite_vec();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO papers(id,title,pdf_path,md_path) VALUES('x','X',?1,'')",
            [lib.join("x/missing.pdf").to_str().unwrap()],
        )
        .unwrap();
        let target = root.join("backup");
        snapshot(&conn, &lib, &target, serde_json::Value::Null).unwrap();
        assert!(validate(&target).is_err());
        assert!(rewrite_paths(&conn, Path::new("/other"), &lib).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_in_backups() {
        use std::os::unix::fs::symlink;
        let root = temp();
        fs::write(root.join("private"), "secret").unwrap();
        symlink(root.join("private"), root.join("link")).unwrap();
        assert!(copy_tree(&root.join("link"), &root.join("copied")).is_err());
        assert!(!root.join("copied").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
pub fn library_storage_path() -> Result<String, String> {
    Settings::load().and_then(|settings| settings.papers_dir())
        .map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
}
