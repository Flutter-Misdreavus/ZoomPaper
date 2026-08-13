//! MinerU 云解析客户端（mineru.net 精准解析 API v4）。
//!
//! 本地文件三步流程（官方文档「批量文件解析 → 本地文件批量上传」）：
//! 1. `POST /file-urls/batch` 申请预签名上传链接 → 拿 `batch_id` + `file_urls`
//! 2. `PUT` 文件字节到签名 URL（无需 Content-Type）
//! 3. 轮询 `GET /extract-results/batch/{batch_id}` → done 后下载 zip 解出 markdown + 图片 + 结构化 JSON

use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::json;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const BASE_URL: &str = "https://mineru.net/api/v4";
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// MinerU 解析结果：markdown 全文 + 其余资源文件（相对路径 → 字节）。
pub struct ExtractedOutput {
    pub markdown: String,
    /// 键为 zip 内相对路径（如 `images/xxx.jpg`、`content_list.json`）。
    pub files: Vec<(String, Vec<u8>)>,
}

/// MinerU 云 API 客户端。
pub struct MineruClient {
    http: Client,
    api_key: String,
}

impl MineruClient {
    pub fn new(api_key: String) -> Self {
        Self {
            http: Client::new(),
            api_key,
        }
    }

    /// 上传 PDF 并轮询直到解析完成，返回完整解析结果。
    pub async fn extract_pdf(&self, pdf_path: &Path) -> Result<ExtractedOutput> {
        let bytes = tokio::fs::read(pdf_path).await.context("读取 PDF 失败")?;
        let file_name = pdf_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "paper.pdf".to_string());

        // 1. 申请预签名上传链接
        let resp = self
            .http
            .post(format!("{BASE_URL}/file-urls/batch"))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "files": [{ "name": file_name }],
                "model_version": "vlm"
            }))
            .send()
            .await
            .context("申请 MinerU 上传链接失败")?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.context("解析 MinerU 响应失败")?;
        if !status.is_success() {
            anyhow::bail!("MinerU 申请上传链接返回错误 {status}: {body}");
        }
        let batch_id = body["data"]["batch_id"]
            .as_str()
            .context("MinerU 响应缺少 batch_id")?
            .to_string();
        let upload_url = body["data"]["file_urls"][0]
            .as_str()
            .context("MinerU 响应缺少 file_urls")?
            .to_string();

        // 2. PUT 上传文件到签名 URL
        let up = self
            .http
            .put(&upload_url)
            .body(bytes)
            .send()
            .await
            .context("上传 PDF 到 MinerU 失败")?;
        if !up.status().is_success() {
            anyhow::bail!("MinerU 上传返回错误 {}", up.status());
        }

        // 3. 轮询 batch 结果，直到 done
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let resp = self
                .http
                .get(format!("{BASE_URL}/extract-results/batch/{batch_id}"))
                .bearer_auth(&self.api_key)
                .send()
                .await
                .context("查询 MinerU 任务失败")?;
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.context("解析 MinerU 响应失败")?;
            if !status.is_success() {
                anyhow::bail!("MinerU 查询任务返回错误 {status}: {body}");
            }
            let result = &body["data"]["extract_result"][0];
            match result["state"].as_str().unwrap_or("") {
                "done" => {
                    let zip_url = result["full_zip_url"]
                        .as_str()
                        .context("MinerU 结果缺少 full_zip_url")?;
                    return self.download_and_extract(zip_url).await;
                }
                "failed" => {
                    let msg = result["err_msg"].as_str().unwrap_or("未知原因");
                    anyhow::bail!("MinerU 解析失败: {msg}");
                }
                _ => continue, // waiting-file / pending / running / converting
            }
        }
    }

    /// 下载结果压缩包，解出 `full.md` + 图片 + 结构化 JSON。
    ///
    /// 丢弃重复的 `origin.pdf`（本地已存原始 PDF）。zip 可能把所有内容
    /// 嵌套在一个顶层目录下（如 `demo/full.md`），先定位 `full.md` 以确定
    /// 前缀，再统一去掉该前缀。
    async fn download_and_extract(&self, zip_url: &str) -> Result<ExtractedOutput> {
        let bytes = self
            .http
            .get(zip_url)
            .send()
            .await
            .context("下载 MinerU 结果失败")?
            .bytes()
            .await
            .context("读取 MinerU 结果失败")?;

        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("解压 MinerU 结果失败")?;

        // 定位 full.md，确定需要去掉的顶层目录前缀
        let prefix = {
            let mut p = String::new();
            for i in 0..archive.len() {
                let name = archive.by_index(i)?.name().to_string();
                if name == "full.md" || name.ends_with("/full.md") {
                    if let Some(idx) = name.rfind('/') {
                        p = name[..=idx].to_string(); // 含末尾 /
                    }
                    break;
                }
            }
            p
        };

        let mut markdown = String::new();
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).context("读取 zip 条目失败")?;
            if entry.is_dir() {
                continue;
            }
            let raw_name = entry.name().to_string();

            // 去掉顶层目录前缀（若存在）
            let name = raw_name.strip_prefix(&prefix).unwrap_or(&raw_name).to_string();

            // 跳过重复的原始 PDF（MinerU 命名为 `origin.pdf` 或 `{hash}_origin.pdf`）
            if name.ends_with("origin.pdf") {
                continue;
            }

            if name == "full.md" {
                entry.read_to_string(&mut markdown).context("读取 full.md 失败")?;
            } else {
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).context("读取 zip 文件失败")?;
                files.push((name, buf));
            }
        }

        if markdown.is_empty() {
            anyhow::bail!("MinerU 结果压缩包缺少 full.md");
        }

        Ok(ExtractedOutput { markdown, files })
    }
}
