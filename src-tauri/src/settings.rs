//! 应用设置：settings.json 的读写。
//!
//! 所有 API Key、论文库路径、embedding 模型等用户偏好都保存在这里，
//! 前端通过 Settings 页读写，后端模块通过本模块读取。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 应用数据目录：`~/Library/Application Support/com.paper-reader/`
pub fn app_data_dir() -> Result<PathBuf> {
    dirs::data_dir()
        .map(|d| d.join("com.paper-reader"))
        .context("无法定位系统数据目录")
}

/// 各 LLM / 解析服务的 API Key。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiKeys {
    /// MinerU 云解析（mineru.net）
    pub mineru: String,
    /// OpenAI
    pub openai: String,
    /// Anthropic
    pub anthropic: String,
    /// Gemini
    pub gemini: String,
    /// DeepSeek
    pub deepseek: String,
}

/// 完整应用设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub api_keys: ApiKeys,
    /// 论文库路径；None 表示使用默认的 `<app_data>/papers`
    pub paper_library_path: Option<PathBuf>,
    /// 本地 embedding 模型名（fastembed）
    pub embedding_model: String,
    /// 对话用的默认 LLM provider
    pub llm_provider: String,
    /// 对话用的默认模型名
    pub llm_model: String,
    /// 联网搜索 provider：`none` / `auto` / `deepseek` / `anthropic`（复用对应 API Key）
    pub web_search_provider: String,
    /// 原生搜索用的模型名；None 用 provider 默认（deepseek-v4-flash / llm_model）
    pub web_search_model: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            api_keys: ApiKeys::default(),
            paper_library_path: None,
            embedding_model: "bge-small-en-v1.5".to_string(),
            llm_provider: "openai".to_string(),
            llm_model: "gpt-4o-mini".to_string(),
            web_search_provider: "none".to_string(),
            web_search_model: None,
        }
    }
}

impl Settings {
    /// settings.json 的完整路径。
    pub fn path() -> Result<PathBuf> {
        Ok(app_data_dir()?.join("settings.json"))
    }

    /// 从磁盘加载；文件不存在时写入默认值并返回。
    pub fn load() -> Result<Self> {
        let path = Self::path()?;
        if !path.exists() {
            let default = Self::default();
            default.save()?;
            return Ok(default);
        }
        let raw = fs::read_to_string(&path).context("读取 settings.json 失败")?;
        let s = serde_json::from_str(&raw).context("解析 settings.json 失败")?;
        Ok(s)
    }

    /// 持久化到磁盘。
    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self).context("序列化 settings 失败")?;
        fs::write(&path, raw).context("写入 settings.json 失败")?;
        Ok(())
    }

    /// 论文库目录：用户自定义路径，或默认的 `<app_data>/papers`。
    pub fn papers_dir(&self) -> Result<PathBuf> {
        if let Some(p) = &self.paper_library_path {
            Ok(p.clone())
        } else {
            Ok(app_data_dir()?.join("papers"))
        }
    }

    /// 解析联网搜索 provider：返回 `(provider, model)`；不可用时返回 None。
    ///
    /// - `deepseek` → 需 `api_keys.deepseek` 非空，模型默认 `deepseek-v4-flash`（DSH 默认值）；
    /// - `anthropic` → 需 `api_keys.anthropic` 非空，模型默认当前 `llm_model`（若 provider 是
    ///   anthropic）否则 `claude-sonnet-4-6`；
    /// - `auto` → 优先 deepseek 再 anthropic（任一 Key 非空即可用）。
    pub fn web_search_available(&self) -> Option<(String, String)> {
        let provider = self.web_search_provider.to_lowercase();
        let model = |default: &str| {
            self.web_search_model
                .clone()
                .unwrap_or_else(|| default.to_string())
        };
        let candidates: Vec<(&str, bool, String)> = vec![
            (
                "deepseek",
                !self.api_keys.deepseek.is_empty(),
                model("deepseek-v4-flash"),
            ),
            (
                "anthropic",
                !self.api_keys.anthropic.is_empty(),
                model(if self.llm_provider.eq_ignore_ascii_case("anthropic") {
                    self.llm_model.as_str()
                } else {
                    "claude-sonnet-4-6"
                }),
            ),
        ];
        match provider.as_str() {
            "deepseek" | "anthropic" => candidates
                .into_iter()
                .find(|(p, _, _)| *p == provider)
                .filter(|(_, ok, _)| *ok)
                .map(|(p, _, m)| (p.to_string(), m)),
            "auto" => candidates
                .into_iter()
                .find(|(_, ok, _)| *ok)
                .map(|(p, _, m)| (p.to_string(), m)),
            _ => None,
        }
    }
}
