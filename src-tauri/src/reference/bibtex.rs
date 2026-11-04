//! Zotero BibTeX 导出解析器。
//!
//! 只处理 Zotero 常见导出形态：`@type{key, field = {value}, ...}`。
//! 不实现完整 BibLaTeX 宏系统；忽略 `@comment` / `@preamble` / `@string`。

use super::model::{ParseOutput, ReferenceParseError, ReferenceRecord};

#[derive(Debug, Default)]
struct RawEntry {
    kind: String,
    key: String,
    fields: std::collections::BTreeMap<String, String>,
}

pub fn parse(input: &str) -> ParseOutput {
    let chars: Vec<char> = input.chars().collect();
    let mut out = ParseOutput::default();
    let mut index = 0usize;
    let mut cursor = 0usize;
    while cursor < chars.len() {
        if chars[cursor] != '@' {
            cursor += 1;
            continue;
        }
        let entry_index = index;
        index += 1;
        let entry_start = cursor;
        match parse_entry(&chars, &mut cursor) {
            Ok(Some(raw)) => match to_record(raw) {
                Ok(record) => out.records.push(record),
                Err(message) => out.errors.push(ReferenceParseError {
                    index: entry_index,
                    key: None,
                    message,
                }),
            },
            Ok(None) => {}
            Err(message) => {
                out.errors.push(ReferenceParseError {
                    index: entry_index,
                    key: None,
                    message,
                });
                // 恢复扫描位置到下一个 `@`，避免损坏条目的字段解析吞掉后续条目。
                cursor = entry_start + 1;
            }
        }
        if cursor == 0 {
            break;
        }
    }
    out
}

fn parse_entry(chars: &[char], cursor: &mut usize) -> Result<Option<RawEntry>, String> {
    // at '@'
    *cursor += 1;
    skip_ws(chars, cursor);
    let kind_start = *cursor;
    while *cursor < chars.len() && chars[*cursor].is_ascii_alphabetic() {
        *cursor += 1;
    }
    if kind_start == *cursor {
        return Err("条目缺少类型".to_string());
    }
    let kind: String = chars[kind_start..*cursor].iter().collect::<String>().to_lowercase();
    skip_ws(chars, cursor);
    let open = chars
        .get(*cursor)
        .copied()
        .ok_or_else(|| "条目不完整".to_string())?;
    let close = match open {
        '{' => '}',
        '(' => ')',
        _ => return Err("条目缺少左花括号".to_string()),
    };
    *cursor += 1;

    // @comment / @preamble / @string：跳过整段
    if matches!(kind.as_str(), "comment" | "preamble" | "string") {
        skip_balanced(chars, cursor, open, close)?;
        return Ok(None);
    }

    skip_ws(chars, cursor);
    let key_start = *cursor;
    let mut brace_depth = 0i32;
    while *cursor < chars.len() {
        let ch = chars[*cursor];
        if ch == '{' {
            brace_depth += 1;
        } else if ch == '}' && brace_depth > 0 {
            brace_depth -= 1;
        } else if ch == ',' && brace_depth == 0 {
            break;
        } else if ch == close && brace_depth == 0 {
            break;
        }
        *cursor += 1;
    }
    let key: String = chars[key_start..*cursor]
        .iter()
        .collect::<String>()
        .trim()
        .trim_matches(['{', '}'])
        .to_string();

    let mut fields = std::collections::BTreeMap::new();
    loop {
        skip_ws(chars, cursor);
        if *cursor >= chars.len() {
            return Err("条目未闭合".to_string());
        }
        if chars[*cursor] == ',' {
            *cursor += 1;
            continue;
        }
        if chars[*cursor] == close {
            *cursor += 1;
            break;
        }
        let name_start = *cursor;
        while *cursor < chars.len() {
            let ch = chars[*cursor];
            if matches!(ch, '=' | ',' | '}' | ')') || ch.is_whitespace() {
                break;
            }
            *cursor += 1;
        }
        let name: String = chars[name_start..*cursor]
            .iter()
            .collect::<String>()
            .trim()
            .to_lowercase();
        skip_ws(chars, cursor);
        if chars.get(*cursor) != Some(&'=') {
            return Err(format!("字段 `{name}` 缺少等号"));
        }
        *cursor += 1;
        skip_ws(chars, cursor);
        let mut value = parse_value(chars, cursor, close)?;
        skip_ws(chars, cursor);
        while chars.get(*cursor) == Some(&'#') {
            *cursor += 1;
            skip_ws(chars, cursor);
            value.push_str(&parse_value(chars, cursor, close)?);
            skip_ws(chars, cursor);
        }
        if !name.is_empty() {
            fields.insert(name, value);
        }
    }

    if key.is_empty() {
        return Err("条目缺少 citation key".to_string());
    }
    Ok(Some(RawEntry { kind, key, fields }))
}

fn parse_value(chars: &[char], cursor: &mut usize, entry_close: char) -> Result<String, String> {
    skip_ws(chars, cursor);
    match chars.get(*cursor).copied() {
        Some('{') => {
            *cursor += 1;
            let start = *cursor;
            let mut depth = 1i32;
            while *cursor < chars.len() {
                match chars[*cursor] {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            let value = chars[start..*cursor].iter().collect();
                            *cursor += 1;
                            return Ok(value);
                        }
                    }
                    _ => {}
                }
                *cursor += 1;
            }
            Err("字段值花括号未闭合".to_string())
        }
        Some('"') => {
            *cursor += 1;
            let start = *cursor;
            let mut escaped = false;
            while *cursor < chars.len() {
                let ch = chars[*cursor];
                if ch == '"' && !escaped {
                    let value = chars[start..*cursor].iter().collect();
                    *cursor += 1;
                    return Ok(value);
                }
                escaped = ch == '\\' && !escaped;
                if ch != '\\' {
                    escaped = false;
                }
                *cursor += 1;
            }
            Err("字段值引号未闭合".to_string())
        }
        Some(ch) if ch == entry_close => Err("字段缺少值".to_string()),
        Some(_) => {
            let start = *cursor;
            while *cursor < chars.len()
                && chars[*cursor] != ','
                && chars[*cursor] != entry_close
                && chars[*cursor] != '#'
            {
                *cursor += 1;
            }
            let value = chars[start..*cursor]
                .iter()
                .collect::<String>()
                .trim()
                .to_string();
            if value.is_empty() {
                Err("字段值不能为空".to_string())
            } else {
                Ok(value)
            }
        }
        None => Err("字段值不完整".to_string()),
    }
}

fn skip_balanced(
    chars: &[char],
    cursor: &mut usize,
    open: char,
    close: char,
) -> Result<(), String> {
    let mut depth = 1i32;
    while *cursor < chars.len() {
        let ch = chars[*cursor];
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                *cursor += 1;
                return Ok(());
            }
        }
        *cursor += 1;
    }
    Err("条目未闭合".to_string())
}

fn skip_ws(chars: &[char], cursor: &mut usize) {
    while *cursor < chars.len() && chars[*cursor].is_whitespace() {
        *cursor += 1;
    }
}

fn to_record(raw: RawEntry) -> Result<ReferenceRecord, String> {
    let field = |names: &[&str]| -> Option<String> {
        names
            .iter()
            .find_map(|name| raw.fields.get(*name))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let title = field(&["title"])
        .map(|value| clean_latex(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| raw.key.clone());
    let authors = field(&["author", "editor"])
        .map(|value| split_authors(&value))
        .unwrap_or_default();
    let year = field(&["year", "date"]).and_then(|value| year_from_text(&value));
    let venue = field(&[
        "journal",
        "journaltitle",
        "booktitle",
        "publisher",
        "school",
        "institution",
        "howpublished",
    ])
    .map(|value| clean_latex(&value))
    .filter(|value| !value.is_empty());
    let raw_doi = field(&["doi"]);
    let doi = raw_doi
        .as_deref()
        .and_then(crate::publication::normalize_doi);
    let mut url = field(&["url"]).filter(|value| is_http_url(value));
    if url.is_none() {
        url = doi.as_deref().map(|doi| format!("https://doi.org/{doi}"));
    }
    let abstract_text = field(&["abstract"]).map(|value| clean_latex(&value));
    let attachment_paths = field(&["file"])
        .map(|value| parse_file_field(&value))
        .unwrap_or_default();

    Ok(ReferenceRecord {
        key: raw.key,
        item_type: item_type(&raw.kind),
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

fn item_type(kind: &str) -> String {
    match kind {
        "article" => "journalArticle",
        "inproceedings" | "conference" => "conferencePaper",
        "incollection" | "inbook" => "bookSection",
        "book" | "proceedings" => "book",
        "phdthesis" | "mastersthesis" | "thesis" => "thesis",
        "techreport" | "report" => "report",
        "unpublished" => "manuscript",
        "online" | "www" => "webpage",
        "misc" => "misc",
        _ => "misc",
    }
    .to_string()
}

fn is_http_url(value: &str) -> bool {
    let lower = value.trim().to_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
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

/// 去 LaTeX 命令/花括号，保留可读文本。保守处理，优先可读性而不是完整排版还原。
pub fn clean_latex(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '\\' => {
                i += 1;
                let Some(&next) = chars.get(i) else { break };
                if next.is_ascii_alphabetic() {
                    // 跳过命令名；命令参数的花括号会在后续循环中自然去掉
                    while i < chars.len() && chars[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                } else {
                    match next {
                        '&' | '%' | '_' | '#' | '$' | '{' | '}' | ' ' => out.push(next),
                        _ => {
                            // 重音命令（\"o、\'e 等）：保留后面的字符即可
                        }
                    }
                    i += 1;
                }
            }
            '{' | '}' => i += 1,
            '~' => {
                out.push(' ');
                i += 1;
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    let cleaned = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("---", "—")
        .replace("--", "–");
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按 BibTeX 的顶层 `and` 拆作者，忽略花括号内部的 and。
pub fn split_authors(raw: &str) -> Vec<String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut authors = Vec::new();
    let mut start = 0usize;
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 && i + 4 <= chars.len() {
            let candidate: String = chars[i..i + 4].iter().collect();
            if candidate.eq_ignore_ascii_case(" and")
                && (i + 4 == chars.len() || chars[i + 4].is_whitespace() || chars[i + 4] == '{')
            {
                let name: String = chars[start..i].iter().collect();
                let cleaned = clean_latex(&name);
                if !cleaned.is_empty() {
                    authors.push(cleaned);
                }
                i += 4;
                start = i;
                continue;
            }
        }
        i += 1;
    }
    let last: String = chars[start..].iter().collect();
    let cleaned = clean_latex(&last);
    if !cleaned.is_empty() {
        authors.push(cleaned);
    }
    let mut seen = std::collections::HashSet::new();
    authors.retain(|author| seen.insert(author.to_lowercase()));
    authors
}

/// 从 Zotero `file` 字段中提取 PDF 路径。
///
/// 支持：
/// - `Label:/path/to/a.pdf:application/pdf`
/// - `/path/to/a.pdf`
/// - `C:\\Users\\me\\a.pdf`
/// - `storage:abc123.pdf`
/// - 多个附件用 `;` 分隔
pub fn parse_file_field(raw: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for part in raw.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(path) = extract_pdf_path(part) {
            if !paths.iter().any(|existing| existing == &path) {
                paths.push(path);
            }
        }
    }
    paths
}

fn extract_pdf_path(part: &str) -> Option<String> {
    let lower = part.to_lowercase();
    let pdf_end = lower.find(".pdf")? + 4;
    let prefix = &part[..pdf_end];
    let start = if let Some(index) = lower[..pdf_end].find("storage:") {
        // Zotero storage 相对路径：保留 `storage:` 前缀交给附件解析器处理
        index
    } else if let Some(index) = lower[..pdf_end].find("attachments:") {
        index
    } else if prefix.len() >= 3 && prefix.as_bytes()[1] == b':' && prefix.as_bytes()[2] == b'\\' {
        0
    } else if let Some(colon) = prefix.rfind(':') {
        // Zotero 格式的第一个冒号前是标签；路径本身可能含冒号，取最后一个能形成 .pdf 的起点
        colon + 1
    } else {
        0
    };
    let path = prefix[start..].trim().trim_matches(['"', '\'']).trim();
    (!path.is_empty()).then(|| path.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
@article{smith2020,
  title = {A {Nested} Title with \& More},
  author = {Smith, John and Doe, Jane},
  journal = {Journal of Testing},
  year = {2020},
  doi = {10.1145/ABC},
  abstract = {An abstract with \\textit{emphasis}.},
  file = {Full Text PDF:/Users/me/Zotero/storage/ABC/smith2020.pdf:application/pdf},
  url = {https://example.com/paper},
}

@inproceedings{li2021,
  title = {Second Paper},
  author = {Li, Wei},
  booktitle = {Proceedings of TestConf},
  date = {2021-05-01},
  file = {C:\Users\me\paper.pdf},
}
"#;

    #[test]
    fn parses_zotero_bibtex_fields_and_attachments() {
        let out = parse(SAMPLE);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(out.records.len(), 2);
        let first = &out.records[0];
        assert_eq!(first.key, "smith2020");
        assert_eq!(first.item_type, "journalArticle");
        assert_eq!(first.title, "A Nested Title with & More");
        assert_eq!(first.authors, vec!["Smith, John", "Doe, Jane"]);
        assert_eq!(first.year, Some(2020));
        assert_eq!(first.venue.as_deref(), Some("Journal of Testing"));
        assert_eq!(first.doi.as_deref(), Some("10.1145/abc"));
        assert_eq!(
            first.attachment_paths,
            vec!["/Users/me/Zotero/storage/ABC/smith2020.pdf"]
        );
        assert!(first.abstract_text.as_deref().unwrap().contains("emphasis"));

        let second = &out.records[1];
        assert_eq!(second.item_type, "conferencePaper");
        assert_eq!(second.year, Some(2021));
        assert_eq!(second.attachment_paths, vec!["C:/Users/me/paper.pdf"]);
    }

    #[test]
    fn keeps_balanced_braces_and_multiple_attachments() {
        let input = r#"@misc{k1,
          title = {A {B {C}} title},
          file = {first:storage:a.pdf:application/pdf; second:storage:b.pdf:application/pdf},
        }"#;
        let out = parse(input);
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].title, "A B C title");
        assert_eq!(
            out.records[0].attachment_paths,
            vec!["storage:a.pdf", "storage:b.pdf"]
        );
    }

    #[test]
    fn reports_malformed_entry_without_aborting_file() {
        let input = r#"@article{broken, title = {oops}
@article{ok, title={Good}, year={2022}}"#;
        let out = parse(input);
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].key, "ok");
        assert!(!out.errors.is_empty());
    }

    #[test]
    fn cleans_latex_commands_and_splits_authors() {
        assert_eq!(
            clean_latex(r#"{\"O}rdinary \textit{Title}"#),
            "Ordinary Title"
        );
        assert_eq!(
            split_authors("Smith, John and {Doe and Co}, Jane"),
            vec!["Smith, John", "Doe and Co, Jane"]
        );
    }
}
