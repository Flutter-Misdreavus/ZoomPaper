//! MinerU 云解析客户端（mineru.net）。
//!
//! 流程：上传 PDF → 轮询任务状态 → 返回 Markdown。

use anyhow::{Context, Result};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use std::path::Path;
use std::time::Duration;

const BASE_URL: &str = "https://mineru.net/api/v4";

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

    /// 上传 PDF 并轮询直到解析完成，返回 Markdown 文本。
    pub async fn extract_pdf(&self, pdf_path: &Path) -> Result<String> {
        let bytes = tokio::fs::read(pdf_path)
            .await
            .context("读取 PDF 失败")?;
        let file_name = pdf_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "paper.pdf".to_string());

        let form = Form::new().part(
            "file",
            Part::bytes(bytes)
                .file_name(file_name)
                .mime_str("application/pdf")?,
        );

        // 1. 创建解析任务
        let resp = self
            .http
            .post(format!("{BASE_URL}/extract/task"))
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await
            .context("创建 MinerU 任务失败")?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.context("解析 MinerU 响应失败")?;
        if !status.is_success() {
            anyhow::bail!("MinerU 创建任务返回错误 {status}: {body}");
        }
        let task_id = body["data"]["task_id"]
            .as_str()
            .context("MinerU 响应缺少 task_id")?
            .to_string();

        // 2. 轮询任务结果
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let resp = self
                .http
                .get(format!("{BASE_URL}/extract/task/{task_id}"))
                .bearer_auth(&self.api_key)
                .send()
                .await
                .context("查询 MinerU 任务失败")?;
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.context("解析 MinerU 响应失败")?;
            if !status.is_success() {
                anyhow::bail!("MinerU 查询任务返回错误 {status}: {body}");
            }
            match body["data"]["state"].as_str().unwrap_or("") {
                "done" => {
                    let md = body["data"]["extract_result"][0]["md"]
                        .as_str()
                        .context("MinerU 结果缺少 markdown")?
                        .to_string();
                    return Ok(md);
                }
                "failed" => anyhow::bail!("MinerU 解析失败: {body}"),
                _ => continue, // waiting / running
            }
        }
    }
}
