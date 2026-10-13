//! DOI metadata enrichment. Public APIs, bounded requests and persistent cache.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Publication {
    pub doi: String,
    pub title: String,
    pub venue: Option<String>,
    pub authors: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Cached {
    fetched_at: i64,
    publication: Option<Publication>,
}

pub fn normalize_doi(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix("https://doi.org/")
        .or_else(|| raw.strip_prefix("http://doi.org/"))
        .or_else(|| raw.strip_prefix("https://dx.doi.org/"))
        .unwrap_or(raw);
    let raw = if raw
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("doi:"))
    {
        raw[4..].trim()
    } else {
        raw
    };
    let decoded = decode_percent(raw)?;
    let raw = decoded.trim_end_matches(['.', ',', ';', ' ']);
    if raw.len() > 250
        || !raw.starts_with("10.")
        || raw
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '#'))
    {
        return None;
    }
    let (prefix, suffix) = raw.split_once('/')?;
    let digits = prefix.strip_prefix("10.")?;
    if !(4..=9).contains(&digits.len())
        || !digits.bytes().all(|c| c.is_ascii_digit())
        || suffix.is_empty()
    {
        return None;
    }
    Some(raw.to_lowercase())
}
fn decode_percent(raw: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw.as_bytes()[i] == b'%' {
            let pair = raw.get(i + 1..i + 3)?;
            bytes.push(u8::from_str_radix(pair, 16).ok()?);
            i += 3;
        } else {
            bytes.push(raw.as_bytes()[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}
/// Search only the supplied header, never the full reference list.
pub fn doi_candidates(header: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut rest = header;
    while let Some(index) = rest.find("10.") {
        let raw = &rest[index..];
        let end = raw
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | ']' | '}'))
            .unwrap_or(raw.len());
        let mut candidate = raw[..end].trim_end_matches(['.', ',', ';']);
        // Markdown links contribute a trailing parenthesis; balanced DOI parentheses are legal.
        while candidate.ends_with(')')
            && candidate.matches(')').count() > candidate.matches('(').count()
        {
            candidate = &candidate[..candidate.len() - 1];
        }
        if let Some(doi) = normalize_doi(candidate) {
            if !result.contains(&doi) {
                result.push(doi);
            }
        }
        if result.len() >= 3 {
            break;
        }
        rest = &raw[3..];
    }
    result
}
fn clean(raw: &str) -> String {
    let mut tag = false;
    raw.chars()
        .filter(|c| {
            if *c == '<' {
                tag = true;
                return false;
            }
            if *c == '>' {
                tag = false;
                return false;
            }
            !tag
        })
        .collect::<String>()
        .replace("&amp;", "&")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn title_tokens(raw: &str) -> Vec<String> {
    clean(raw)
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
pub fn title_matches(a: &str, b: &str) -> bool {
    let a = title_tokens(a);
    let b = title_tokens(b);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    if a.len().min(b.len()) < 5 {
        return false;
    }
    let a: std::collections::HashSet<_> = a.into_iter().collect();
    let b: std::collections::HashSet<_> = b.into_iter().collect();
    2.0 * a.intersection(&b).count() as f64 / (a.len() + b.len()) as f64 >= 0.90
}
fn text(value: &Value) -> Option<String> {
    value.as_str().map(clean).filter(|s| !s.is_empty())
}
pub fn crossref_record(value: &Value, doi: &str) -> Option<Publication> {
    let m = value.get("message")?;
    if normalize_doi(m["DOI"].as_str()?)?.as_str() != doi {
        return None;
    }
    let title = text(&m["title"][0])?;
    let venue = text(&m["event"]["name"]).or_else(|| text(&m["container-title"][0]));
    let year = m["event"]["start"]["date-parts"][0][0]
        .as_i64()
        .or_else(|| m["published"]["date-parts"][0][0].as_i64())
        .or_else(|| m["published-print"]["date-parts"][0][0].as_i64());
    let venue = venue.map(|name| match year.filter(|y| (1900..=2100).contains(y)) {
        Some(y) if !name.contains(&y.to_string()) => format!("{name} {y}"),
        _ => name,
    });
    let authors: Vec<String> = m["author"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            text(&a["name"]).or_else(|| {
                let name = [
                    a["given"].as_str().unwrap_or(""),
                    a["family"].as_str().unwrap_or(""),
                ]
                .join(" ");
                (!name.trim().is_empty()).then(|| clean(&name))
            })
        })
        .collect();
    Some(Publication {
        doi: doi.into(),
        title,
        venue,
        authors: (!authors.is_empty()).then(|| authors.join(", ")),
    })
}
pub fn datacite_record(value: &Value, doi: &str) -> Option<Publication> {
    let m = &value["data"]["attributes"];
    if normalize_doi(m["doi"].as_str()?)?.as_str() != doi {
        return None;
    }
    let title = text(&m["titles"][0]["title"])?;
    // Publisher is not the journal/conference. Repositories must not become venues.
    let venue = text(&m["container"]["title"]).or_else(|| {
        m["relatedItems"]
            .as_array()?
            .iter()
            .find(|item| item["relationType"] == "IsPublishedIn")
            .and_then(|item| text(&item["titles"][0]["title"]))
    });
    let venue = venue.map(|name| match m["publicationYear"].as_i64() {
        Some(y) if (1900..=2100).contains(&y) && !name.contains(&y.to_string()) => {
            format!("{name} {y}")
        }
        _ => name,
    });
    let authors: Vec<String> = m["creators"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| text(&a["name"]))
        .collect();
    Some(Publication {
        doi: doi.into(),
        title,
        venue,
        authors: (!authors.is_empty()).then(|| authors.join(", ")),
    })
}

pub async fn lookup(doi: &str, cache_dir: &Path) -> Result<Option<Publication>, String> {
    let doi = normalize_doi(doi).ok_or("DOI 无效")?;
    // Crossref public pool permits one concurrent request. Also deduplicates cache misses.
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = GATE
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let hex = doi.bytes().map(|b| format!("{b:02x}")).collect::<String>();
    let mut cache_parent = cache_dir.to_path_buf();
    let mut rest = hex.as_str();
    while rest.len() > 200 {
        cache_parent.push(&rest[..200]);
        rest = &rest[200..];
    }
    let cache_file = cache_parent.join(format!("{rest}.json"));
    if let Ok(raw) = std::fs::read(&cache_file) {
        if let Ok(cached) = serde_json::from_slice::<Cached>(&raw) {
            let ttl = if cached.publication.is_some() {
                30 * 86400
            } else {
                86400
            };
            if chrono::Utc::now().timestamp() - cached.fetched_at < ttl {
                return Ok(cached.publication);
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("ZoomPaper/0.3.1 (https://github.com/Flutter-Misdreavus/ZoomPaper)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut publication = None;
    static RETRY_AFTER: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    for (base, crossref) in [
        ("https://api.crossref.org/works/", true),
        ("https://api.datacite.org/dois/", false),
    ] {
        if chrono::Utc::now().timestamp() < RETRY_AFTER.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("DOI 服务限流，稍后重试".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let mut url = reqwest::Url::parse(base).unwrap();
        url.path_segments_mut().unwrap().pop_if_empty().push(&doi);
        let response = client.get(url).send().await.map_err(|e| e.to_string())?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let seconds = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(60)
                .clamp(1, 3600);
            RETRY_AFTER.store(
                chrono::Utc::now().timestamp() + seconds,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("DOI 查询状态 {}", response.status()));
        }
        // Bound response memory, including chunked responses without Content-Length.
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("DOI 元数据过大".into());
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        publication = if crossref {
            crossref_record(&value, &doi)
        } else {
            datacite_record(&value, &doi)
        };
        if publication.is_some() {
            break;
        }
    }
    let cached = Cached {
        fetched_at: chrono::Utc::now().timestamp(),
        publication: publication.clone(),
    };
    if std::fs::create_dir_all(cache_parent).is_ok() {
        let _ = std::fs::write(cache_file, serde_json::to_vec(&cached).unwrap());
    }
    Ok(publication)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn doi_extraction_and_validation() {
        assert_eq!(
            normalize_doi("https://doi.org/10.1145%2F123.456"),
            Some("10.1145/123.456".into())
        );
        assert_eq!(
            doi_candidates("DOI: [10.1145/123.456](https://doi.org/10.1145/123.456)."),
            vec!["10.1145/123.456"]
        );
        assert!(normalize_doi("10.123/invalid").is_none());
        assert!(normalize_doi("../../secret").is_none());
        assert_eq!(
            doi_candidates("https://doi.org/10.1007/example(2026)"),
            vec!["10.1007/example(2026)"]
        );
    }
    #[test]
    fn refuses_reference_or_short_partial_title() {
        assert!(title_matches(
            "A Method for Efficient Retrieval of Documents",
            "A Method for Efficient Retrieval of Documents."
        ));
        assert!(!title_matches("Paper A", "Paper B"));
        assert!(!title_matches(
            "Gradient-aware Multi-source Retrieval Optimization",
            "A Completely Different Retrieval Paper"
        ));
    }
    #[test]
    fn publisher_not_venue_and_doi_must_match() {
        let value = json!({"message":{"DOI":"10.1145/test","title":["Example"],"publisher":"ACM","author":[{"given":"A","family":"Smith"}]}});
        let record = crossref_record(&value, "10.1145/test").unwrap();
        assert_eq!(record.venue, None);
        assert_eq!(record.authors.as_deref(), Some("A Smith"));
        assert!(crossref_record(&value, "10.1145/other").is_none());
        let value = json!({"data":{"attributes":{"doi":"10.5281/example","titles":[{"title":"Data"}],"publisher":"Zenodo"}}});
        assert_eq!(
            datacite_record(&value, "10.5281/example").unwrap().venue,
            None
        );
    }
    #[test]
    fn unknown_journals_and_event_year_are_preserved() {
        let value = json!({"message":{"DOI":"10.1145/test","title":["Example"],"container-title":["Unlisted Research Journal"],"published":{"date-parts":[[2026]]}}});
        assert_eq!(
            crossref_record(&value, "10.1145/test")
                .unwrap()
                .venue
                .as_deref(),
            Some("Unlisted Research Journal 2026")
        );
    }
    #[tokio::test]
    async fn persistent_cache_avoids_network() {
        let directory = std::env::temp_dir().join(format!("doi-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let doi = "10.1145/cached";
        let path = directory.join(format!(
            "{}.json",
            doi.bytes().map(|b| format!("{b:02x}")).collect::<String>()
        ));
        let cached = Cached {
            fetched_at: chrono::Utc::now().timestamp(),
            publication: Some(Publication {
                doi: doi.into(),
                title: "Cached paper".into(),
                venue: Some("NewConf 2026".into()),
                authors: None,
            }),
        };
        std::fs::write(path, serde_json::to_vec(&cached).unwrap()).unwrap();
        assert_eq!(
            lookup(doi, &directory).await.unwrap().unwrap().title,
            "Cached paper"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires access to the public Crossref service"]
    async fn crossref_live_lookup() {
        let directory = std::env::temp_dir().join(format!("doi-live-{}", uuid::Uuid::new_v4()));
        let record = lookup("10.1145/3786583.3786856", &directory)
            .await
            .unwrap()
            .unwrap();
        assert!(record.title.starts_with("EvoC2Rust:"));
        assert!(record.venue.unwrap().contains("Software Engineering"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
