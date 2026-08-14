//! RAG：分块、向量入库、检索。
//!
//! 分块基于 MinerU 的 `content_list.json`（扁平 reading-order 语义块），
//! 按阅读顺序把正文块合并到约 `CHUNK_CHAR_LIMIT` 字符，标题处断开。
//! 向量写入 sqlite-vec 的 `vec_chunks`（rowid 对齐 `paper_chunks.id`）。

use crate::ai::embed;
use crate::db::models::SearchHit;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use zerocopy::AsBytes;

/// 合并后的单个 chunk 目标长度（字符）。
const CHUNK_CHAR_LIMIT: usize = 800;

/// content_list.json 中的单个块。
#[derive(Debug, Clone, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub text: Option<String>,
    pub text_level: Option<i32>,
    pub bbox: Option<Vec<f32>>,
    pub page_idx: Option<i32>,
}

/// 分块草稿（入库前）。
#[derive(Debug, Clone)]
pub struct ChunkDraft {
    pub section: String,
    pub content: String,
    pub start_block: i64,
    pub end_block: i64,
    pub page_idx: Option<i64>,
    pub bbox: Option<String>,
}

/// 按阅读顺序分块。标题（`text_level >= 1`）处断开并更新 section。
/// `image`/`table`/`equation` 等非文本块跳过（embedding 模型是文本模型）。
pub fn chunk_content_list(blocks: &[ContentBlock]) -> Vec<ChunkDraft> {
    let mut chunks = Vec::new();
    let mut section = String::new();
    let mut buf = String::new();
    let mut start_block: i64 = 0;
    let mut start_page: Option<i64> = None;
    let mut start_bbox: Option<String> = None;

    fn flush(
        chunks: &mut Vec<ChunkDraft>,
        section: &str,
        buf: &mut String,
        start_block: i64,
        end_block: i64,
        start_page: Option<i64>,
        start_bbox: Option<String>,
    ) {
        if !buf.trim().is_empty() {
            chunks.push(ChunkDraft {
                section: section.to_string(),
                content: buf.trim().to_string(),
                start_block,
                end_block,
                page_idx: start_page,
                bbox: start_bbox,
            });
        }
        buf.clear();
    }

    for (i, block) in blocks.iter().enumerate() {
        let idx = i as i64;
        let text = block.text.as_deref().unwrap_or("").trim();

        // 标题：断开当前 chunk，更新 section
        if block.text_level.unwrap_or(0) >= 1 && !text.is_empty() {
            flush(
                &mut chunks,
                &section,
                &mut buf,
                start_block,
                idx.saturating_sub(1),
                start_page,
                start_bbox.clone(),
            );
            section = text.to_string();
            start_block = idx;
            start_page = block.page_idx.map(i64::from);
            start_bbox = block
                .bbox
                .as_ref()
                .map(|b| serde_json::to_string(b).unwrap_or_default());
            continue;
        }

        // 只处理正文文本块
        if block.block_type != "text" || text.is_empty() {
            continue;
        }

        // 首个正文块记录起始定位
        if buf.is_empty() {
            start_block = idx;
            start_page = block.page_idx.map(i64::from);
            start_bbox = block
                .bbox
                .as_ref()
                .map(|b| serde_json::to_string(b).unwrap_or_default());
        }

        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(text);

        // 超长则 flush
        if buf.chars().count() >= CHUNK_CHAR_LIMIT {
            flush(
                &mut chunks,
                &section,
                &mut buf,
                start_block,
                idx,
                start_page,
                start_bbox.clone(),
            );
        }
    }

    // 收尾
    flush(
        &mut chunks,
        &section,
        &mut buf,
        start_block,
        blocks.len() as i64 - 1,
        start_page,
        start_bbox,
    );

    chunks
}

/// 从论文目录找到旧版 content_list.json 路径（`_content_list.json` 结尾精确排除 v2）。
fn find_content_list(paper_dir: &Path) -> Result<std::path::PathBuf> {
    for entry in fs::read_dir(paper_dir).context("读取论文目录失败")? {
        let path = entry?.path();
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.ends_with("_content_list.json") {
                return Ok(path);
            }
        }
    }
    anyhow::bail!("论文目录缺少 content_list.json")
}

/// 索引一篇论文：分块 → embedding → 入库。返回 chunk 数量。
pub fn index_paper(conn: &Connection, paper_id: &str) -> Result<usize> {
    let md_path: String = conn
        .query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [paper_id],
            |r| r.get(0),
        )
        .context("查询论文 md_path 失败")?;
    let paper_dir = Path::new(&md_path).parent().context("md_path 无父目录")?;

    let cl_path = find_content_list(paper_dir)?;
    let raw = fs::read_to_string(&cl_path).context("读取 content_list.json 失败")?;
    let blocks: Vec<ContentBlock> =
        serde_json::from_str(&raw).context("解析 content_list.json 失败")?;

    let drafts = chunk_content_list(&blocks);
    if drafts.is_empty() {
        return Ok(0);
    }

    // 分批 embedding
    let mut embeddings = Vec::with_capacity(drafts.len());
    for batch in drafts.chunks(32) {
        let texts: Vec<&str> = batch.iter().map(|d| d.content.as_str()).collect();
        embeddings.extend(embed::embed_texts(&texts).context("生成 embedding 失败")?);
    }

    insert_chunks(conn, paper_id, &drafts, &embeddings)?;
    Ok(drafts.len())
}

/// 事务内写入 chunks 与向量（重索引幂等：先删旧数据）。
pub fn insert_chunks(
    conn: &Connection,
    paper_id: &str,
    drafts: &[ChunkDraft],
    embeddings: &[Vec<f32>],
) -> Result<()> {
    assert_eq!(
        drafts.len(),
        embeddings.len(),
        "chunks 与 embeddings 数量不一致"
    );

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM paper_chunks WHERE paper_id = ?1)",
        [paper_id],
    )?;
    tx.execute("DELETE FROM paper_chunks WHERE paper_id = ?1", [paper_id])?;

    for (draft, embedding) in drafts.iter().zip(embeddings) {
        tx.execute(
            "INSERT INTO paper_chunks (paper_id, section, content, start_line, end_line, \
             page_idx, bbox) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                paper_id,
                draft.section,
                draft.content,
                draft.start_block,
                draft.end_block,
                draft.page_idx,
                draft.bbox,
            ],
        )?;
        let chunk_id = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO vec_chunks (rowid, embedding, paper_id) VALUES (?1, ?2, ?3)",
            params![chunk_id, embedding.as_bytes(), paper_id],
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// 检索：向量化查询 → vec0 KNN → JOIN paper_chunks 拿内容。
///
/// `paper_id_filter` 为 `Some` 时只在该论文内检索。
pub fn search(
    conn: &Connection,
    query: &str,
    top_k: usize,
    paper_id_filter: Option<&str>,
) -> Result<Vec<SearchHit>> {
    let q = embed::embed_query(query).context("向量化查询失败")?;
    search_with_embedding(conn, &q, top_k, paper_id_filter)
}

/// 用已向量化的查询做检索（纯 DB 逻辑，便于测试）。
pub fn search_with_embedding(
    conn: &Connection,
    query_embedding: &[f32],
    top_k: usize,
    paper_id_filter: Option<&str>,
) -> Result<Vec<SearchHit>> {
    let q_bytes = query_embedding.as_bytes();

    // 第一步：vec0 KNN 拿 rowid + distance（k 用 format 拼，避免 vec0 参数化 k 兼容问题）
    let mut rowids: Vec<i64> = Vec::new();
    let mut distances: Vec<f32> = Vec::new();
    {
        if let Some(pid) = paper_id_filter {
            let sql = format!(
                "SELECT rowid, distance FROM vec_chunks \
                 WHERE embedding MATCH ?1 AND paper_id = ?2 AND k = {top_k}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![q_bytes, pid])?;
            while let Some(row) = rows.next()? {
                rowids.push(row.get(0)?);
                distances.push(row.get(1)?);
            }
        } else {
            let sql = format!(
                "SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ?1 AND k = {top_k}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![q_bytes])?;
            while let Some(row) = rows.next()? {
                rowids.push(row.get(0)?);
                distances.push(row.get(1)?);
            }
        }
    }

    // 第二步：JOIN paper_chunks 拿内容
    let mut out = Vec::with_capacity(rowids.len());
    for (rowid, distance) in rowids.iter().zip(distances) {
        let chunk = conn.query_row(
            "SELECT paper_id, section, content, page_idx FROM paper_chunks WHERE id = ?1",
            [rowid],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            },
        )?;
        out.push(SearchHit {
            chunk_id: *rowid,
            paper_id: chunk.0,
            section: chunk.1,
            content: chunk.2,
            page_idx: chunk.3,
            distance,
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    fn block(block_type: &str, text: &str, level: i32, page: i32) -> ContentBlock {
        ContentBlock {
            block_type: block_type.to_string(),
            text: Some(text.to_string()),
            text_level: Some(level),
            bbox: Some(vec![0.0, 0.0, 100.0, 100.0]),
            page_idx: Some(page),
        }
    }

    #[test]
    fn chunking_splits_on_title_and_merges_body() {
        let blocks = vec![
            block("title", "Introduction", 1, 0),
            block("text", "First sentence.", 0, 0),
            block("text", "Second sentence.", 0, 0),
            block("title", "Method", 1, 1),
            block("text", "Third sentence.", 0, 1),
            block("image", "", 0, 1), // 非文本块应跳过
        ];
        let chunks = chunk_content_list(&blocks);

        assert_eq!(chunks.len(), 2);
        // 第一个 chunk：Introduction 下的两句话
        assert_eq!(chunks[0].section, "Introduction");
        assert!(chunks[0].content.contains("First sentence."));
        assert!(chunks[0].content.contains("Second sentence."));
        // 第二个 chunk：Method 下的正文
        assert_eq!(chunks[1].section, "Method");
        assert_eq!(chunks[1].content, "Third sentence.");
        assert_eq!(chunks[1].page_idx, Some(1));
    }

    #[test]
    fn chunking_keeps_oversized_block_intact() {
        let long: String = "word ".repeat(300); // ~1500 字符，超过 800 阈值
        let blocks = vec![block("text", &long, 0, 0)];
        let chunks = chunk_content_list(&blocks);
        // 超长单块作为整体语义单元保持完整（bge 上限 512 tokens 足够容纳）
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, long.trim());
    }

    fn setup_db() -> Connection {
        db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::migrate(&conn).unwrap();
        // 插入论文记录以满足 paper_chunks.paper_id 外键
        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path) VALUES ('paper-a', 'A', '/a.pdf', '/a.md')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path) VALUES ('paper-b', 'B', '/b.pdf', '/b.md')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn insert_and_search_align_rowid() {
        let conn = setup_db();

        // 两篇论文的 chunk，用 one-hot 向量区分
        let drafts = vec![
            ChunkDraft {
                section: "Intro".into(),
                content: "alpha chunk".into(),
                start_block: 0,
                end_block: 1,
                page_idx: Some(0),
                bbox: None,
            },
            ChunkDraft {
                section: "Method".into(),
                content: "beta chunk".into(),
                start_block: 2,
                end_block: 3,
                page_idx: Some(1),
                bbox: None,
            },
        ];
        let mut v0 = vec![0.0f32; 384];
        v0[0] = 1.0;
        let mut v1 = vec![0.0f32; 384];
        v1[1] = 1.0;
        let embeddings = vec![v0.clone(), v1.clone()];

        insert_chunks(&conn, "paper-a", &drafts, &embeddings).unwrap();

        // 跨论文检索，查询 = v0，应命中 alpha chunk（distance 0）
        let hits = search_with_embedding(&conn, &v0, 2, None).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "alpha chunk");
        assert_eq!(hits[0].paper_id, "paper-a");
        assert!(hits[0].distance < hits[1].distance);

        // paper_id 过滤：查不存在的论文，返回空
        let filtered = search_with_embedding(&conn, &v0, 2, Some("paper-b")).unwrap();
        assert!(filtered.is_empty());
    }

    /// 真实端到端：真实数据库 + 真实 content_list + 真实 embedding 模型。
    /// 需联网下载 bge 模型，且数据库里已有解析完成的论文，故默认跳过。
    #[test]
    #[ignore = "需要真实 embedding 模型下载与已解析论文"]
    fn real_index_paper_end_to_end() {
        let dir = crate::settings::app_data_dir().unwrap();
        let conn = crate::db::open(&dir.join("database.sqlite")).unwrap();

        let paper_id: String = conn
            .query_row(
                "SELECT id FROM papers WHERE parse_status = 'ready' ORDER BY created_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("数据库里应有至少一篇已解析论文");

        let n = index_paper(&conn, &paper_id).expect("真实索引失败");
        assert!(n > 0, "应产生至少一个 chunk");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM paper_chunks WHERE paper_id = ?1",
                [&paper_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, n as i64, "paper_chunks 行数应与 chunk 数一致");

        // 检索冒烟：模型已加载，直接查询应命中
        let hits = search(&conn, "transformer", 3, Some(&paper_id)).unwrap();
        assert!(!hits.is_empty(), "检索应命中 chunk");
    }
}
