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
#[cfg(not(test))]
const POLL_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(test)]
const POLL_INTERVAL: Duration = Duration::from_millis(2);

/// MinerU 解析结果：markdown 全文 + 其余资源文件（相对路径 → 字节）。
pub struct ExtractedOutput {
    pub markdown: String,
    /// 键为 zip 内相对路径（如 `images/xxx.jpg`、`content_list.json`）。
    pub files: Vec<(String, Vec<u8>)>,
}

/// 解析进度事件（推送给前端进度条）。
/// stage：uploading / pending / converting / running / downloading / indexing
#[derive(Debug, Clone, serde::Serialize)]
pub struct ParseProgress {
    pub stage: String,
    /// 仅 stage=running 且 MinerU 返回了 extract_progress 时有值
    pub extracted_pages: Option<u32>,
    pub total_pages: Option<u32>,
}

impl ParseProgress {
    fn stage(stage: &str) -> Self {
        Self {
            stage: stage.to_string(),
            extracted_pages: None,
            total_pages: None,
        }
    }
}

/// MinerU 云 API 客户端。
pub struct MineruClient {
    http: Client,
    api_key: String,
    base_url: String,
}

impl MineruClient {
    pub fn new(api_key: String) -> Self {
        Self {
            http: Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(180))
                .build()
                .expect("HTTP client configuration"),
            api_key,
            base_url: BASE_URL.into(),
        }
    }

    /// 上传 PDF 并轮询直到解析完成，返回完整解析结果。
    /// `progress` 在各阶段被回调（上传/排队/解析页数/下载），用于前端进度条。
    pub async fn extract_pdf_resumable(
        &self,
        pdf_path: &Path,
        progress: &(dyn Fn(ParseProgress) + Send + Sync),
        resume_batch: Option<&str>,
        save_batch: &(dyn Fn(&str) -> Result<(), String> + Send + Sync),
    ) -> Result<ExtractedOutput> {
        let batch_id = if let Some(id) = resume_batch {
            progress(ParseProgress::stage("pending"));
            id.to_owned()
        } else {
            let bytes = tokio::fs::read(pdf_path).await.context("读取 PDF 失败")?;
            let file_name = pdf_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "paper.pdf".to_string());

            // 1. 申请预签名上传链接
            let resp = self
                .http
                .post(format!("{}/file-urls/batch", self.base_url))
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
            progress(ParseProgress::stage("uploading"));
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

            save_batch(&batch_id).map_err(anyhow::Error::msg)?;
            batch_id
        };
        let started = std::time::Instant::now();
        let mut consecutive_errors = 0;
        // 3. 轮询 batch 结果，直到 done
        loop {
            anyhow::ensure!(
                started.elapsed() < Duration::from_secs(1800),
                "MinerU 解析等待超时，可重试以继续获取结果"
            );
            tokio::time::sleep(POLL_INTERVAL).await;
            let response = self
                .http
                .get(format!(
                    "{}/extract-results/batch/{batch_id}",
                    self.base_url
                ))
                .bearer_auth(&self.api_key)
                .timeout(Duration::from_secs(30))
                .send()
                .await;
            let resp = match response {
                Ok(resp)
                    if resp.status().is_server_error()
                        || resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS =>
                {
                    consecutive_errors += 1;
                    anyhow::ensure!(consecutive_errors <= 3, "MinerU 服务暂时不可用，可稍后重试");
                    progress(ParseProgress::stage("reconnecting"));
                    tokio::time::sleep(Duration::from_secs(5 * consecutive_errors)).await;
                    continue;
                }
                Ok(resp) => {
                    consecutive_errors = 0;
                    resp
                }
                Err(error) => {
                    consecutive_errors += 1;
                    if consecutive_errors > 3 {
                        return Err(error).context("查询 MinerU 任务失败");
                    }
                    progress(ParseProgress::stage("reconnecting"));
                    tokio::time::sleep(Duration::from_secs(5 * consecutive_errors)).await;
                    continue;
                }
            };
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
                    progress(ParseProgress::stage("downloading"));
                    return self.download_and_extract(zip_url).await;
                }
                "failed" => {
                    let msg = result["err_msg"].as_str().unwrap_or("未知原因");
                    anyhow::bail!("MinerU 解析失败: {msg}");
                }
                state => {
                    let mut p = ParseProgress::stage(match state {
                        "converting" => "converting",
                        "running" => "running",
                        _ => "pending", // waiting-file / pending
                    });
                    if state == "running" {
                        p.extracted_pages = result["extract_progress"]["extracted_pages"]
                            .as_u64()
                            .map(|v| v as u32);
                        p.total_pages = result["extract_progress"]["total_pages"]
                            .as_u64()
                            .map(|v| v as u32);
                    }
                    progress(p);
                    continue;
                }
            }
        }
    }

    /// 下载结果压缩包，解出 `full.md` + 图片 + 结构化 JSON。
    ///
    /// 丢弃重复的 `origin.pdf`（本地已存原始 PDF）。zip 可能把所有内容
    /// 嵌套在一个顶层目录下（如 `demo/full.md`），先定位 `full.md` 以确定
    /// 前缀，再统一去掉该前缀。
    async fn download_and_extract(&self, zip_url: &str) -> Result<ExtractedOutput> {
        let mut response = self
            .http
            .get(zip_url)
            .send()
            .await
            .context("下载 MinerU 结果失败")?
            .error_for_status()
            .context("MinerU 结果下载返回错误")?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.context("读取 MinerU 结果失败")? {
            anyhow::ensure!(
                bytes.len() + chunk.len() <= 200 * 1024 * 1024,
                "MinerU 结果文件过大"
            );
            bytes.extend_from_slice(&chunk);
        }
        tokio::task::spawn_blocking(move || Self::extract_archive(bytes))
            .await
            .context("解压任务失败")?
    }

    fn extract_archive(bytes: Vec<u8>) -> Result<ExtractedOutput> {
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

        let mut total = 0_u64;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).context("读取 zip 条目失败")?;
            total = total.saturating_add(entry.size());
            anyhow::ensure!(total <= 512 * 1024 * 1024, "MinerU 解压结果过大");
            if entry.is_dir() {
                continue;
            }
            let raw_name = entry.name().to_string();

            // 去掉顶层目录前缀（若存在）
            let name = raw_name
                .strip_prefix(&prefix)
                .unwrap_or(&raw_name)
                .to_string();

            // 跳过重复的原始 PDF（MinerU 命名为 `origin.pdf` 或 `{hash}_origin.pdf`）
            if name.ends_with("origin.pdf") {
                continue;
            }

            if name == "full.md" {
                entry
                    .read_to_string(&mut markdown)
                    .context("读取 full.md 失败")?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn resumes_saved_cloud_batch_without_uploading_pdf_again() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = requests.clone();
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("full.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"# A Paper\nAbstract").unwrap();
        let archive = zip.finish().unwrap().into_inner();
        let zip_url = format!("{base}/result.zip");
        let server = std::thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut buffer = [0; 4096];
                let n = stream.read(&mut buffer).unwrap();
                captured.lock().unwrap().push(
                    String::from_utf8_lossy(&buffer[..n])
                        .lines()
                        .next()
                        .unwrap()
                        .to_string(),
                );
                let body = if index == 0 {
                    serde_json::json!({"data":{"extract_result":[{"state":"done","full_zip_url":zip_url}]}}).to_string().into_bytes()
                } else {
                    archive.clone()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        let mut client = MineruClient::new("test-key".into());
        client.base_url = base;
        let output = client
            .extract_pdf_resumable(
                Path::new("/nonexistent/never-upload.pdf"),
                &|_| {},
                Some("batch-123"),
                &|_| panic!("Must not create another batch"),
            )
            .await
            .unwrap();
        assert!(output.markdown.starts_with("# A Paper"));
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert!(requests[0].contains("extract-results/batch/batch-123"));
        assert!(requests.iter().all(|request| request.starts_with("GET ")));
    }
}
