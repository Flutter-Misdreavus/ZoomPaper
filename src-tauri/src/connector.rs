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
#[derive(Debug, PartialEq)]
enum Request<'a> {
    Receipt(&'a str),
    Preflight,
}
fn allowed(request: &str) -> Option<Request<'_>> {
    let mut lines = request.lines();
    let mut parts = lines.next()?.split_whitespace();
    let method = parts.next()?;
    let id = parts.next()?.strip_prefix("/imports/")?;
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let headers: Vec<_> = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name, value.trim()))
        .collect();
    let header = |key: &str| -> Option<&str> {
        let mut values = headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(key));
        let value = values.next()?.1;
        if values.next().is_some() {
            return None;
        }
        Some(value)
    };
    // Exact Host prevents DNS rebinding. MV3 workers may omit Origin entirely;
    // reject foreign origins when present rather than assuming Chromium sends it.
    if header("host") != Some("127.0.0.1:37541")
        || header("origin").is_some_and(|origin| origin != ORIGIN)
        || headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("origin"))
            .count()
            > 1
    {
        return None;
    }
    match method {
        "GET" if header("x-zoompaper-receipt") == Some("1") => Some(Request::Receipt(id)),
        // The non-safelisted marker forces ordinary web pages to preflight.
        // Only our extension may pass it; the random request UUID is the capability.
        "OPTIONS"
            if header("origin") == Some(ORIGIN)
                && header("access-control-request-method") == Some("GET")
                && header("access-control-request-headers")
                    .is_some_and(|value| value.eq_ignore_ascii_case("x-zoompaper-receipt")) =>
        {
            Some(Request::Preflight)
        }
        _ => None,
    }
}
fn response(request: &str, read_receipt: impl FnOnce(&str) -> serde_json::Value) -> String {
    let (status, body, cors) = match allowed(request) {
        Some(Request::Receipt(id)) => ("200 OK", read_receipt(id).to_string(), true),
        Some(Request::Preflight) => ("204 No Content", String::new(), true),
        None => ("403 Forbidden", "{}".into(), false),
    };
    let cors = if cors {
        format!("Access-Control-Allow-Origin: {ORIGIN}\r\nAccess-Control-Allow-Methods: GET\r\nAccess-Control-Allow-Headers: X-ZoomPaper-Receipt\r\nVary: Origin\r\n")
    } else {
        String::new()
    };
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cors}Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len())
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
            let response = response(&request, |id| receipt(&app.state::<Db>(), id));
            let _ = stream.write_all(response.as_bytes());
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "12345678-1234-4234-9234-123456789abc";
    fn get(origin: &str) -> String {
        format!("GET /imports/{ID} HTTP/1.1\r\nHost: 127.0.0.1:37541\r\nX-ZoomPaper-Receipt: 1\r\n{origin}\r\n")
    }
    #[test]
    fn mv3_receipts_work_without_origin() {
        let request = get("");
        assert_eq!(allowed(&request), Some(Request::Receipt(ID)));
        let reply = response(&request, |_| serde_json::json!({"state":"accepted"}));
        assert!(reply.starts_with("HTTP/1.1 200 OK"));
        assert!(reply.contains("\r\n\r\n{\"state\":\"accepted\"}"));
    }
    #[test]
    fn own_extension_origin_and_preflight_are_supported() {
        assert_eq!(
            allowed(&get(&format!("Origin: {ORIGIN}\r\n"))),
            Some(Request::Receipt(ID))
        );
        let preflight = format!("OPTIONS /imports/{ID} HTTP/1.1\r\nHost: 127.0.0.1:37541\r\nOrigin: {ORIGIN}\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: x-zoompaper-receipt\r\n\r\n");
        let reply = response(&preflight, |_| panic!("preflight must not read database"));
        assert!(reply.starts_with("HTTP/1.1 204 No Content"));
        assert!(reply.contains("Access-Control-Allow-Headers: X-ZoomPaper-Receipt"));
        assert!(allowed(&preflight.replace(ORIGIN, "https://evil.example")).is_none());
        assert!(allowed(&preflight.replace("x-zoompaper-receipt", "authorization")).is_none());
        assert!(allowed(&preflight.replace("Method: GET", "Method: POST")).is_none());
        assert!(allowed(&preflight.replace(&format!("Origin: {ORIGIN}\r\n"), "")).is_none());
    }
    #[test]
    fn foreign_websites_and_non_receipt_requests_are_rejected() {
        for request in [
            get("Origin: https://evil.example\r\n"),
            get("Origin: null\r\n"),
            get(&format!(
                "Origin: {ORIGIN}\r\nOrigin: https://evil.example\r\n"
            )),
            get("").replace("127.0.0.1:37541", "evil.example:37541"),
            get("").replace("X-ZoomPaper-Receipt: 1\r\n", ""),
            get("").replace("GET", "POST"),
            get("").replace(ID, "../../settings"),
        ] {
            let reply = response(&request, |_| {
                panic!("rejected request must not read database")
            });
            assert!(reply.starts_with("HTTP/1.1 403 Forbidden"));
            assert!(!reply.contains("Access-Control-Allow-Origin"));
        }
    }
}
