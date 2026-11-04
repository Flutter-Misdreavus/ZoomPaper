//! 题录去重与重复置信度计算。

use super::model::{ExistingMatch, ReferenceRecord};

#[derive(Debug, Clone)]
pub struct ExistingPaper {
    pub id: String,
    pub title: String,
    pub doi: Option<String>,
    pub year: Option<i64>,
    pub authors: Option<String>,
    pub has_pdf: bool,
    pub content_hash: Option<String>,
}

pub fn title_tokens(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for ch in raw.chars() {
        if ch.is_alphanumeric() {
            word.extend(ch.to_lowercase());
        } else if !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// 0.0-1.0 的 token Jaccard 相似度。
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let a = title_tokens(a);
    let b = title_tokens(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let a: std::collections::HashSet<_> = a.into_iter().collect();
    let b: std::collections::HashSet<_> = b.into_iter().collect();
    2.0 * a.intersection(&b).count() as f64 / (a.len() + b.len()) as f64
}

pub fn normalized_title(raw: &str) -> String {
    title_tokens(raw).join(" ")
}

fn author_tokens(raw: &str) -> Vec<String> {
    raw.split(|ch: char| !ch.is_alphanumeric())
        .map(str::trim)
        .filter(|part| part.len() >= 2)
        .map(str::to_lowercase)
        .collect()
}

fn author_overlap(record: &ReferenceRecord, existing_authors: Option<&str>) -> bool {
    let Some(authors) = existing_authors else {
        return false;
    };
    let record_tokens: Vec<String> = record
        .authors
        .iter()
        .flat_map(|author| author_tokens(author))
        .collect();
    let existing = author_tokens(authors);
    !record_tokens.is_empty()
        && existing
            .iter()
            .any(|name| record_tokens.iter().any(|record_name| record_name == name))
}

/// 纯函数匹配：返回最合适的现有论文及原因。调用方负责提供当前库快照。
pub fn best_match(
    record: &ReferenceRecord,
    pdf_hash: Option<&str>,
    existing: &[ExistingPaper],
) -> Option<ExistingMatch> {
    let mut best: Option<(u8, &ExistingPaper, &str)> = None;
    for paper in existing {
        if let (Some(doi), Some(other)) = (record.doi.as_deref(), paper.doi.as_deref()) {
            if doi.eq_ignore_ascii_case(other) {
                return Some(match_info(paper, "DOI 相同", 100));
            }
        }
        if let (Some(hash), Some(other)) = (pdf_hash, paper.content_hash.as_deref()) {
            if hash.eq_ignore_ascii_case(other) {
                return Some(match_info(paper, "PDF 内容相同", 100));
            }
        }
        let similarity = title_similarity(&record.title, &paper.title);
        if similarity < 0.85 {
            continue;
        }
        let year_compatible = match (record.year, paper.year) {
            (Some(a), Some(b)) => (a - b).abs() <= 1,
            _ => true,
        };
        let authors_match = author_overlap(record, paper.authors.as_deref());
        let (confidence, reason) = if similarity >= 0.97 && year_compatible {
            (98, "标题与年份高度相似")
        } else if similarity >= 0.95 && year_compatible && authors_match {
            (96, "标题、年份与作者匹配")
        } else {
            (80, "标题疑似重复")
        };
        if best.as_ref().is_none_or(|(score, _, _)| confidence > *score) {
            best = Some((confidence, paper, reason));
        }
    }
    best.map(|(confidence, paper, reason)| match_info(paper, reason, confidence))
}

fn match_info(paper: &ExistingPaper, reason: &str, confidence: u8) -> ExistingMatch {
    ExistingMatch {
        paper_id: paper.id.clone(),
        title: paper.title.clone(),
        doi: paper.doi.clone(),
        year: paper.year,
        has_pdf: paper.has_pdf,
        reason: reason.to_string(),
        confidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(title: &str, doi: Option<&str>, year: Option<i64>) -> ReferenceRecord {
        ReferenceRecord {
            key: "k".into(),
            item_type: "journalArticle".into(),
            title: title.into(),
            authors: vec!["Smith, John".into()],
            year,
            venue: None,
            doi: doi.map(str::to_string),
            url: None,
            abstract_text: None,
            attachment_paths: vec![],
        }
    }

    fn paper(id: &str, title: &str, doi: Option<&str>, year: Option<i64>) -> ExistingPaper {
        ExistingPaper {
            id: id.into(),
            title: title.into(),
            doi: doi.map(str::to_string),
            year,
            authors: Some("Smith, John".into()),
            has_pdf: true,
            content_hash: None,
        }
    }

    #[test]
    fn doi_and_hash_take_priority() {
        let existing = vec![paper("p1", "Other", Some("10.1/abc"), Some(2020))];
        let m = best_match(&record("A title", Some("10.1/ABC"), Some(2020)), None, &existing)
            .unwrap();
        assert_eq!(m.paper_id, "p1");
        assert_eq!(m.confidence, 100);
        assert_eq!(m.reason, "DOI 相同");
    }

    #[test]
    fn title_confidence_is_conservative() {
        let existing = vec![paper(
            "p1",
            "Gradient-aware Multi-source Retrieval Optimization",
            None,
            Some(2020),
        )];
        let exact = best_match(
            &record("Gradient-aware Multi-source Retrieval Optimization", None, Some(2020)),
            None,
            &existing,
        )
        .unwrap();
        assert_eq!(exact.confidence, 98);

        let weak = best_match(
            &record("Gradient-aware Multi-source Retrieval", None, Some(2020)),
            None,
            &existing,
        )
        .unwrap();
        assert_eq!(weak.confidence, 80);
    }

    #[test]
    fn short_titles_do_not_match_loosely() {
        let existing = vec![paper("p1", "Paper A", None, Some(2020))];
        assert!(best_match(&record("Paper B", None, Some(2020)), None, &existing).is_none());
    }
}
