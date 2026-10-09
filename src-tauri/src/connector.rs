//! Loopback-only import receipts. No write API, no listing, no file or model access.
use crate::{db::models::Paper, db::Db};
use rusqlite::{params, OptionalExtension};
use std::io::{Read, Write};
use tauri::{AppHandle, Manager};
static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[tauri::command]
pub fn browser_extension_status() -> bool {
    READY.load(std::sync::atomic::Ordering::Relaxed)
}
const ORIGIN: &str = "chrome-extension://fjmflfompjgilhdknkpogjhpjeanndbn";
pub fn existing_receipt(db: &Db, id: Option<&str>) -> Result<Option<Paper>, String> {
    let Some(id) = id.filter(|s| uuid::Uuid::parse_str(s).is_ok()) else {
        return Ok(None);
    };
    let paper:Option<String>=db.conn().query_row("SELECT paper_id FROM browser_import_receipts WHERE request_id=?1 AND error IS NULL AND paper_id IS NOT NULL",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    paper
        .map(|id| crate::commands::get_paper_inner(db, &id))
        .transpose()
}
pub fn record_receipt(db: &Db, id: Option<&str>, result: &Result<Paper, String>) {
    let Some(id) = id.filter(|s| uuid::Uuid::parse_str(s).is_ok()) else {
        return;
    };
    let (paper, error) = match result {
        Ok(p) => (Some(p.id.as_str()), None),
        Err(e) => (None, Some(e.as_str())),
    };
    let _=db.conn().execute("INSERT INTO browser_import_receipts(request_id,paper_id,error,created_at)VALUES(?1,?2,?3,?4) ON CONFLICT(request_id) DO UPDATE SET paper_id=excluded.paper_id,error=excluded.error",params![id,paper,error,chrono::Utc::now().timestamp()]);
}
fn receipt(db: &Db, id: &str) -> serde_json::Value {
    let row: Option<(Option<String>, Option<String>)> = db
        .conn()
        .query_row(
            "SELECT paper_id,error FROM browser_import_receipts WHERE request_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap_or(None);
    match row {
        Some((Some(paper), None)) => serde_json::json!({"state":"accepted","paperId":paper}),
        Some((_, Some(error))) => serde_json::json!({"state":"error","error":error}),
        _ => serde_json::json!({"state":"waiting"}),
    }
}
fn allowed(request: &str) -> Option<&str> {
    let mut lines = request.lines();
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?;
    let id = path.strip_prefix("/imports/")?;
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let origin = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("origin").then_some(value.trim())
    })?;
    (origin == ORIGIN).then_some(id)
}
pub fn start(app: AppHandle) {
    let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 37541)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("浏览器接收回执服务不可用：{e}");
            return;
        }
    };
    READY.store(true, std::sync::atomic::Ordering::Relaxed);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(2)));
            let mut bytes = [0u8; 8192];
            let mut used = 0;
            while used < bytes.len() {
                match stream.read(&mut bytes[used..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        used += n;
                        if bytes[..used].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            let request = String::from_utf8_lossy(&bytes[..used]);
            let (status, body) = match allowed(&request) {
                Some(id) => ("200 OK", receipt(&app.state::<Db>(), id).to_string()),
                None => ("403 Forbidden", "{}".into()),
            };
            let response=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {ORIGIN}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",body.len());
            let _ = stream.write_all(response.as_bytes());
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_own_extension_with_uuid_can_read_receipt() {
        let id = "12345678-1234-4234-9234-123456789abc";
        let request = format!("GET /imports/{id} HTTP/1.1\r\nOrigin: {ORIGIN}\r\n\r\n");
        assert_eq!(allowed(&request), Some(id));
        assert!(allowed(&request.replace(ORIGIN, "https://evil.example")).is_none());
        assert!(allowed(&request.replace("GET", "POST")).is_none());
        assert!(allowed(&request.replace(id, "../../settings")).is_none());
    }
}
