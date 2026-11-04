//! Zotero RIS 导出解析器。

use super::bibtex::clean_latex;
use super::model::{ParseOutput, ReferenceParseError, ReferenceRecord};

#[derive(Debug, Default)]
struct RawRis {
    tags: Vec<(String, String)>,
}

impl RawRis {
    fn first(&self, names: &[&str]) -> Option<&str> {
        names.iter().find_map(|name| {
            self.tags
                .iter()
                .find(|(tag, _)| tag.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        })
    }

    fn all(&self, names: &[&str]) -> Vec<&str> {
        self.tags
            .iter()
            .filter(|(tag, _)| names.iter().any(|name| tag.eq_ignore_ascii_case(name)))
            .map(|(_, value)| value.as_str())
            .collect()
    }
}

pub fn parse(input: &str) -> ParseOutput {
    let mut out = ParseOutput::default();
    let mut current: Option<RawRis> = None;
    let mut index = 0usize;
    for raw_line in input.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        if line.trim_start().starts_with("ER") {
            if let Some(raw) = current.take() {
                match to_record(raw, index) {
                    Ok(record) => out.records.push(record),
                    Err(message) => out.errors.push(ReferenceParseError {
                        index,
                        key: None,
                        message,
                    }),
                }
                index += 1;
            }
            continue;
        }
        let Some((tag, value)) = split_tag(line) else {
            // 续行：接到最后一个 tag 的值后面
            if let Some(raw) = current.as_mut() {
                if let Some((_, value)) = raw.tags.last_mut() {
                    value.push(' ');
                    value.push_str(line.trim());
                }
            }
            continue;
        };
        if tag.eq_ignore_ascii_case("TY") {
            if let Some(raw) = current.take() {
                match to_record(raw, index) {
                    Ok(record) => out.records.push(record),
                    Err(message) => {
                        out.errors.push(ReferenceParseError {
                            index,
                            key: None,
                            message,
                        });
                        index += 1;
                    }
                }
            }
            let mut raw = RawRis::default();
            raw.tags.push((tag, value));
            current = Some(raw);
        } else if let Some(raw) = current.as_mut() {
            raw.tags.push((tag, value));
        }
    }
    if let Some(raw) = current.take() {
        match to_record(raw, index) {
            Ok(record) => out.records.push(record),
            Err(message) => out.errors.push(ReferenceParseError {
                index,
                key: None,
                message,
            }),
        }
    }
    out
}

fn split_tag(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphanumeric() || !bytes[1].is_ascii_alphanumeric() {
        return None;
    }
    let tag = &trimmed[..2];
    let rest = &trimmed[2..];
    let rest = rest
        .strip_prefix("  - ")
        .or_else(|| rest.strip_prefix(" - "))
        .or_else(|| rest.strip_prefix("- "))?
        .trim();
    Some((tag.to_ascii_uppercase(), rest.to_string()))
}

fn to_record(raw: RawRis, index: usize) -> Result<ReferenceRecord, String> {
    let title = raw
        .first(&["TI", "T1", "BT"])
        .map(clean_latex)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "RIS 条目缺少标题".to_string())?;
    let authors = raw
        .all(&["AU", "A1"])
        .into_iter()
        .map(clean_latex)
        .filter(|author| !author.is_empty())
        .collect::<Vec<_>>();
    let year = raw
        .first(&["PY", "Y1", "DA"])
        .and_then(|value| year_from_text(value));
    let venue = raw
        .first(&["JO", "JF", "T2", "JA"])
        .map(clean_latex)
        .filter(|value| !value.is_empty());
    let doi = raw
        .first(&["DO"])
        .and_then(|value| crate::publication::normalize_doi(value.trim()));
    let mut url = raw
        .first(&["UR", "L2"])
        .map(str::trim)
        .filter(|value| {
            let lower = value.to_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        })
        .map(str::to_string);
    if url.is_none() {
        url = doi.as_deref().map(|doi| format!("https://doi.org/{doi}"));
    }
    let abstract_text = raw
        .first(&["AB", "N2"])
        .map(clean_latex)
        .filter(|value| !value.is_empty());
    let attachment_paths = raw
        .all(&["L1", "L2"])
        .into_iter()
        .flat_map(parse_attachment_values)
        .collect::<Vec<_>>();

    Ok(ReferenceRecord {
        key: format!("ris-{index}"),
        item_type: item_type(raw.first(&["TY"]).unwrap_or("")),
        title,
        authors,
        year,
        venue,
        doi,
        url,
        abstract_text,
        attachment_paths,
    })
}

fn item_type(value: &str) -> String {
    match value.trim().to_ascii_uppercase().as_str() {
        "JOUR" | "JFULL" | "EJOUR" | "ARTICLE" => "journalArticle",
        "CONF" | "CPAPER" => "conferencePaper",
        "CHAP" | "SECTION" => "bookSection",
        "BOOK" | "EBOOK" | "EDBOOK" => "book",
        "THES" | "THESIS" => "thesis",
        "RPRT" | "REPORT" => "report",
        "UNPB" | "MANSCPT" => "manuscript",
        "ELEC" | "WEB" => "webpage",
        _ => "misc",
    }
    .to_string()
}

fn year_from_text(value: &str) -> Option<i64> {
    let mut digits = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            if digits.len() == 4 {
                let year = digits.parse::<i64>().ok()?;
                if (1900..=2100).contains(&year) {
                    return Some(year);
                }
                digits.clear();
            }
        } else {
            digits.clear();
        }
    }
    None
}

fn parse_attachment_values(value: &str) -> Vec<String> {
    let value = value.trim();
    if value.is_empty() {
        return vec![];
    }
    let lower = value.to_lowercase();
    if !lower.contains(".pdf") {
        return vec![];
    }
    let path = value
        .split(';')
        .find(|part| part.to_lowercase().contains(".pdf"))
        .unwrap_or(value)
        .trim()
        .trim_matches(['"', '\'']);
    if path.is_empty() {
        vec![]
    } else {
        vec![path.replace('\\', "/")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "TY  - JOUR\r\n\
TI  - A Paper Title\r\n\
AU  - Smith, John\r\n\
AU  - Doe, Jane\r\n\
PY  - 2020\r\n\
JO  - Journal of Testing\r\n\
DO  - 10.1145/ABC\r\n\
AB  - An abstract.\r\n\
L1  - /Users/me/Zotero/storage/ABC/paper.pdf\r\n\
ER  - \r\n\
\r\n\
TY  - CONF\r\n\
TI  - Second Paper\r\n\
AU  - Li, Wei\r\n\
Y1  - 2021/05/01\r\n\
T2  - Proceedings of TestConf\r\n\
DO  - 10.1145/sec\r\n\
ER  - \r\n";

    #[test]
    fn parses_multiple_ris_records() {
        let out = parse(SAMPLE);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(out.records.len(), 2);
        let first = &out.records[0];
        assert_eq!(first.item_type, "journalArticle");
        assert_eq!(first.title, "A Paper Title");
        assert_eq!(first.authors, vec!["Smith, John", "Doe, Jane"]);
        assert_eq!(first.year, Some(2020));
        assert_eq!(first.venue.as_deref(), Some("Journal of Testing"));
        assert_eq!(first.doi.as_deref(), Some("10.1145/abc"));
        assert_eq!(
            first.attachment_paths,
            vec!["/Users/me/Zotero/storage/ABC/paper.pdf"]
        );

        let second = &out.records[1];
        assert_eq!(second.item_type, "conferencePaper");
        assert_eq!(second.year, Some(2021));
        assert_eq!(
            second.venue.as_deref(),
            Some("Proceedings of TestConf")
        );
    }

    #[test]
    fn skips_missing_title_and_keeps_errors() {
        let out = parse("TY  - JOUR\nAU  - A\nER  - \n");
        assert!(out.records.is_empty());
        assert_eq!(out.errors.len(), 1);
    }
}
