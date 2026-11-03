//! 应用设置：settings.json 的读写。
//!
//! 所有 API Key、论文库路径、embedding 模型等用户偏好都保存在这里，
//! 前端通过 Settings 页读写，后端模块通过本模块读取。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// API Key 保存在本地明文 JSON 中；Unix 平台限制为仅当前用户可读写。
#[cfg(unix)]
fn harden_settings_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("限制 settings.json 文件权限失败")
}

#[cfg(not(unix))]
fn harden_settings_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

/// 应用数据目录。保留旧目录名以便升级后继续读取已有论文和设置。
pub fn app_data_dir() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = option_env!("ZOOMPAPER_TEST_DATA_DIR") {
        let path = PathBuf::from(path);
        anyhow::ensure!(path.is_absolute(), "测试数据目录必须为绝对路径");
        return Ok(path);
    }
    dirs::data_dir()
        .map(|d| d.join("com.paper-reader"))
        .context("无法定位系统数据目录")
}

/// 各 LLM / 解析服务的 API Key（旧版结构，保留用于迁移）。
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

/// 单个 Provider 配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Provider 唯一标识（如 "openai", "deepseek", "custom-openai-1"）
    pub id: String,
    /// 显示名称
    pub name: String,
    /// Provider 类型：openai-compat / anthropic
    pub provider_type: String,
    /// API Key
    pub api_key: String,
    /// Base URL（openai-compat 类型必填）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// 默认模型名
    pub default_model: String,
    /// 可选：支持的模型列表（用于前端下拉提示）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// 单次联网搜索默认返回条数。
pub const WEB_SEARCH_DEFAULT_COUNT: u32 = 8;

/// DeepSeek 官方 Base URL（DeepSeek Provider 未填 base_url 时使用）。
pub const DEEPSEEK_DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

fn default_web_search_count() -> u32 {
    WEB_SEARCH_DEFAULT_COUNT
}

/// 联网搜索运行配置：已从 providers 解析出实际生效的 provider、Key、Base URL 与条数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSearchConfig {
    /// 搜索后端：`deepseek` / `anthropic`
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    /// 仅 Anthropic 原生搜索使用；DeepSeek Search API 不需要模型名。
    pub model: Option<String>,
    /// 单次返回条数（已限制在 1-50）。
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowSettings {
    pub auto_parse: bool,
    pub parse_concurrency: u32,
    pub auto_doi: bool,
    pub auto_metadata_translation: bool,
    pub auto_full_translation: bool,
}
impl Default for WorkflowSettings {
    fn default() -> Self {
        Self {
            auto_parse: true,
            parse_concurrency: 2,
            auto_doi: true,
            auto_metadata_translation: true,
            auto_full_translation: false,
        }
    }
}

/// 完整应用设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub workflow: WorkflowSettings,
    /// Provider 配置列表（新版）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ProviderConfig>,
    /// 当前激活的 provider ID（新版）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub active_provider_id: String,

    /// 兼容字段：保留旧版 api_keys 用于平滑迁移
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_keys: Option<ApiKeys>,
    /// 兼容字段：旧版 llm_provider
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_provider: Option<String>,
    /// 兼容字段：旧版 llm_model
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,

    /// MinerU API Key（保留在顶层，不纳入 providers）
    #[serde(default)]
    pub mineru_api_key: String,
    /// 论文库路径；None 表示使用默认的 `<app_data>/papers`
    pub paper_library_path: Option<PathBuf>,
    /// 本地 embedding 模型名（fastembed）
    pub embedding_model: String,
    /// 联网搜索 provider：`none` / `auto` / `deepseek` / `anthropic`
    /// （deepseek 使用官方 Search/Fetch API，anthropic 使用原生 web_search 工具）
    pub web_search_provider: String,
    /// Anthropic 原生搜索用的模型名；None 用 provider 默认模型
    pub web_search_model: Option<String>,
    /// 单次联网搜索返回条数（1-50，默认 8）
    #[serde(default = "default_web_search_count")]
    pub web_search_count: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            workflow: WorkflowSettings::default(),
            providers: vec![],
            active_provider_id: String::new(),
            api_keys: None,
            llm_provider: None,
            llm_model: None,
            mineru_api_key: String::new(),
            paper_library_path: None,
            embedding_model: "bge-small-en-v1.5".to_string(),
            web_search_provider: "auto".to_string(),
            web_search_model: None,
            web_search_count: WEB_SEARCH_DEFAULT_COUNT,
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
        harden_settings_permissions(&path)?;
        let raw = fs::read_to_string(&path).context("读取 settings.json 失败")?;
        let mut s: Settings = serde_json::from_str(&raw).context("解析 settings.json 失败")?;

        // 自动迁移旧配置
        if s.migrate_from_legacy() {
            s.save()?;
        }

        Ok(s)
    }

    /// 持久化到磁盘。
    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self).context("序列化 settings 失败")?;
        crate::fs::write_md(&path, &raw).context("写入 settings.json 失败")?;
        harden_settings_permissions(&path)?;
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

    /// 从 providers 列表中获取当前激活的 provider。
    pub fn active_provider(&self) -> Result<&ProviderConfig> {
        self.providers
            .iter()
            .find(|p| p.id == self.active_provider_id && p.enabled)
            .with_context(|| format!("当前激活的 provider '{}' 不存在", self.active_provider_id))
    }

    /// 迁移旧配置到新结构（api_keys → providers）。
    pub fn migrate_from_legacy(&mut self) -> bool {
        // 新配置已经生效时，只清理不再使用的旧字段。
        if !self.providers.is_empty() {
            let had_legacy =
                self.api_keys.is_some() || self.llm_provider.is_some() || self.llm_model.is_some();
            if self.mineru_api_key.is_empty() {
                if let Some(keys) = &self.api_keys {
                    self.mineru_api_key = keys.mineru.clone();
                }
            }
            self.api_keys = None;
            self.llm_provider = None;
            self.llm_model = None;
            return had_legacy;
        }

        let api_keys = match &self.api_keys {
            Some(keys) => keys,
            None => return false,
        };

        let old_provider = self.llm_provider.as_deref().unwrap_or("openai");
        let old_model = self.llm_model.as_deref().unwrap_or("gpt-4o-mini");

        // 转换旧的 api_keys 为 providers
        let mut providers = Vec::new();

        if !api_keys.openai.is_empty() {
            providers.push(ProviderConfig {
                id: "openai".to_string(),
                name: "OpenAI".to_string(),
                provider_type: "openai-compat".to_string(),
                api_key: api_keys.openai.clone(),
                base_url: Some("https://api.openai.com/v1".to_string()),
                default_model: if old_provider == "openai" {
                    old_model.to_string()
                } else {
                    "gpt-4o-mini".to_string()
                },
                enabled: true,
                models: vec![
                    "gpt-4o".to_string(),
                    "gpt-4o-mini".to_string(),
                    "gpt-4-turbo".to_string(),
                    "gpt-3.5-turbo".to_string(),
                ],
            });
        }

        if !api_keys.anthropic.is_empty() {
            providers.push(ProviderConfig {
                id: "anthropic".to_string(),
                name: "Anthropic Claude".to_string(),
                provider_type: "anthropic".to_string(),
                api_key: api_keys.anthropic.clone(),
                base_url: None,
                default_model: if old_provider == "anthropic" {
                    old_model.to_string()
                } else {
                    "claude-sonnet-4-6".to_string()
                },
                enabled: true,
                models: vec![
                    "claude-sonnet-4-6".to_string(),
                    "claude-opus-4".to_string(),
                    "claude-haiku-4".to_string(),
                ],
            });
        }

        if !api_keys.deepseek.is_empty() {
            providers.push(ProviderConfig {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                provider_type: "openai-compat".to_string(),
                api_key: api_keys.deepseek.clone(),
                base_url: Some("https://api.deepseek.com".to_string()),
                default_model: if old_provider == "deepseek" {
                    old_model.to_string()
                } else {
                    "deepseek-chat".to_string()
                },
                enabled: true,
                models: vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()],
            });
        }

        if !api_keys.gemini.is_empty() {
            providers.push(ProviderConfig {
                id: "gemini".to_string(),
                name: "Google Gemini".to_string(),
                provider_type: "openai-compat".to_string(),
                api_key: api_keys.gemini.clone(),
                base_url: Some(
                    "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
                ),
                default_model: if old_provider == "gemini" {
                    old_model.to_string()
                } else {
                    "gemini-2.0-flash-exp".to_string()
                },
                enabled: true,
                models: vec![
                    "gemini-2.0-flash-exp".to_string(),
                    "gemini-1.5-pro".to_string(),
                ],
            });
        }

        // MinerU 提取到顶层字段
        if self.mineru_api_key.is_empty() {
            self.mineru_api_key = api_keys.mineru.clone();
        }

        // 设置激活的 provider
        if !providers.is_empty() {
            self.active_provider_id = providers
                .iter()
                .find(|p| p.id == old_provider)
                .map(|p| p.id.clone())
                .unwrap_or_else(|| providers[0].id.clone());
        }

        self.providers = providers;
        self.api_keys = None;
        self.llm_provider = None;
        self.llm_model = None;
        true
    }

    /// 查找可用于联网搜索的 provider（存在、启用且 Key 非空）。
    fn search_provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers
            .iter()
            .find(|p| p.id == id && p.enabled && !p.api_key.trim().is_empty())
    }

    /// 单次搜索条数（限制在官方允许的 1-50）。
    fn search_count(&self) -> usize {
        self.web_search_count.clamp(1, 50) as usize
    }

    fn deepseek_search_config(&self) -> Option<WebSearchConfig> {
        let provider = self.search_provider("deepseek")?;
        Some(WebSearchConfig {
            provider: "deepseek".to_string(),
            api_key: provider.api_key.trim().to_string(),
            base_url: provider
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|base| !base.is_empty())
                .unwrap_or(DEEPSEEK_DEFAULT_BASE_URL)
                .to_string(),
            model: None,
            count: self.search_count(),
        })
    }

    fn anthropic_search_config(&self) -> Option<WebSearchConfig> {
        let provider = self.search_provider("anthropic")?;
        let model = self
            .web_search_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_string)
            .or_else(|| {
                let model = provider.default_model.trim();
                (!model.is_empty()).then(|| model.to_string())
            })
            .unwrap_or_else(|| "claude-sonnet-4-6".to_string());
        Some(WebSearchConfig {
            provider: "anthropic".to_string(),
            api_key: provider.api_key.trim().to_string(),
            base_url: provider
                .base_url
                .as_deref()
                .map(str::trim)
                .map(|base| base.trim_end_matches('/').to_string())
                .filter(|base| !base.is_empty())
                .unwrap_or_else(|| "https://api.anthropic.com/v1".to_string()),
            model: Some(model),
            count: self.search_count(),
        })
    }

    /// 解析当前设置下实际生效的联网搜索配置；不可用时返回 None。
    ///
    /// - `deepseek` → 使用官方 Search/Fetch API（复用 DeepSeek Provider 的 Key 与 Base URL）；
    /// - `anthropic` → 使用 Anthropic 原生 `web_search` 工具，模型取
    ///   `web_search_model` / Provider 默认模型 / `claude-sonnet-4-6`；
    /// - `auto` → 优先 deepseek，再 anthropic（任一可用即可）；
    /// - `none` 或未知值 → None。
    pub fn web_search_config(&self) -> Option<WebSearchConfig> {
        match self.web_search_provider.trim().to_lowercase().as_str() {
            "deepseek" => self.deepseek_search_config(),
            "anthropic" => self.anthropic_search_config(),
            "auto" => self
                .deepseek_search_config()
                .or_else(|| self.anthropic_search_config()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_web_provider_is_auto_and_keys_gate_availability() {
        let mut s = Settings::default();
        assert_eq!(s.web_search_provider, "auto");
        assert_eq!(s.web_search_count, WEB_SEARCH_DEFAULT_COUNT);
        // 无 provider → 不可用
        assert!(s.web_search_config().is_none());

        // 添加 deepseek provider → 可用（auto 优先 deepseek）
        s.providers.push(ProviderConfig {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            provider_type: "openai-compat".to_string(),
            api_key: "sk-test".to_string(),
            base_url: Some("https://api.deepseek.com".to_string()),
            default_model: "deepseek-chat".to_string(),
            models: vec![],
            enabled: true,
        });
        let config = s.web_search_config().unwrap();
        assert_eq!(config.provider, "deepseek");
        assert_eq!(config.base_url, "https://api.deepseek.com");
        assert_eq!(config.count, WEB_SEARCH_DEFAULT_COUNT as usize);
        assert!(config.model.is_none());

        // 只有 anthropic provider 时选 anthropic
        let mut s2 = Settings::default();
        s2.providers.push(ProviderConfig {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            provider_type: "anthropic".to_string(),
            api_key: "sk-ant-test".to_string(),
            base_url: None,
            default_model: "claude-sonnet-4-6".to_string(),
            models: vec![],
            enabled: true,
        });
        let config2 = s2.web_search_config().unwrap();
        assert_eq!(config2.provider, "anthropic");
        assert_eq!(config2.base_url, "https://api.anthropic.com/v1");
        assert_eq!(config2.model.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[test]
    fn web_search_config_resolves_explicit_provider_count_and_model() {
        let mut s = Settings::default();
        s.providers.push(ProviderConfig {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            provider_type: "openai-compat".to_string(),
            api_key: "sk-test".to_string(),
            base_url: Some("https://api.deepseek.com/v1".to_string()),
            default_model: "deepseek-chat".to_string(),
            models: vec![],
            enabled: true,
        });
        s.providers.push(ProviderConfig {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            provider_type: "anthropic".to_string(),
            api_key: "sk-ant".to_string(),
            base_url: Some("https://api.anthropic.com/v1/".to_string()),
            default_model: "claude-provider-default".to_string(),
            models: vec![],
            enabled: true,
        });

        // 显式选择 anthropic + 覆盖模型 + 条数上限
        s.web_search_provider = "anthropic".into();
        s.web_search_model = Some("claude-custom".into());
        s.web_search_count = 100;
        let config = s.web_search_config().unwrap();
        assert_eq!(config.provider, "anthropic");
        assert_eq!(config.model.as_deref(), Some("claude-custom"));
        assert_eq!(config.base_url, "https://api.anthropic.com/v1");
        assert_eq!(config.count, 50);

        // 未覆盖模型时用 Provider 默认模型
        s.web_search_model = None;
        s.web_search_count = 5;
        let config = s.web_search_config().unwrap();
        assert_eq!(config.model.as_deref(), Some("claude-provider-default"));
        assert_eq!(config.count, 5);

        // 关闭 / 未知值 → 不可用
        s.web_search_provider = "none".into();
        assert!(s.web_search_config().is_none());
        s.web_search_provider = "unknown".into();
        assert!(s.web_search_config().is_none());

        // 显式选择 deepseek 时不要求 anthropic 可用
        s.web_search_provider = "deepseek".into();
        assert_eq!(s.web_search_config().unwrap().provider, "deepseek");
    }

    #[test]
    fn disabled_or_keyless_provider_is_not_used() {
        let mut s = Settings::default();
        s.web_search_provider = "deepseek".into();
        s.providers.push(ProviderConfig {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            provider_type: "openai-compat".to_string(),
            api_key: "   ".to_string(),
            base_url: None,
            default_model: "deepseek-chat".to_string(),
            models: vec![],
            enabled: true,
        });
        assert!(s.web_search_config().is_none());

        s.providers[0].api_key = "sk-test".to_string();
        s.providers[0].enabled = false;
        assert!(s.web_search_config().is_none());
    }

    #[test]
    fn old_settings_without_web_search_count_default_to_eight() {
        let s: Settings =
            serde_json::from_str(r#"{"providers":[],"web_search_provider":"deepseek"}"#).unwrap();
        assert_eq!(s.web_search_provider, "deepseek");
        assert_eq!(s.web_search_count, WEB_SEARCH_DEFAULT_COUNT);
        assert_eq!(s.web_search_count, 8);
    }

    #[test]
    fn migrate_from_legacy_converts_api_keys() {
        let mut s = Settings {
            api_keys: Some(ApiKeys {
                mineru: "mineru-key".to_string(),
                openai: "sk-openai".to_string(),
                anthropic: "sk-ant".to_string(),
                gemini: "".to_string(),
                deepseek: "sk-deepseek".to_string(),
            }),
            llm_provider: Some("deepseek".to_string()),
            llm_model: Some("deepseek-chat".to_string()),
            ..Default::default()
        };

        s.migrate_from_legacy();

        // 应该生成 3 个 provider（openai, anthropic, deepseek）
        assert_eq!(s.providers.len(), 3);
        assert!(s.providers.iter().any(|p| p.id == "openai"));
        assert!(s.providers.iter().any(|p| p.id == "anthropic"));
        assert!(s.providers.iter().any(|p| p.id == "deepseek"));

        // active_provider_id 应该设为 deepseek
        assert_eq!(s.active_provider_id, "deepseek");

        // deepseek 的 default_model 应该继承旧的 llm_model
        let deepseek = s.providers.iter().find(|p| p.id == "deepseek").unwrap();
        assert_eq!(deepseek.default_model, "deepseek-chat");

        // MinerU key 应该提取到顶层
        assert_eq!(s.mineru_api_key, "mineru-key");
        assert!(s.api_keys.is_none(), "迁移后不应继续保留旧密钥副本");
        assert!(!s.migrate_from_legacy(), "重复加载不应再次迁移");
    }

    #[test]
    fn active_provider_returns_enabled_provider() {
        let mut s = Settings::default();
        s.providers.push(ProviderConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            provider_type: "openai-compat".to_string(),
            api_key: "sk-test".to_string(),
            base_url: Some("https://api.test.com".to_string()),
            default_model: "test-model".to_string(),
            models: vec![],
            enabled: true,
        });
        s.active_provider_id = "test".to_string();

        let provider = s.active_provider().unwrap();
        assert_eq!(provider.id, "test");
        assert_eq!(provider.api_key, "sk-test");
    }

    #[test]
    fn active_provider_fails_if_disabled() {
        let mut s = Settings::default();
        s.providers.push(ProviderConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            provider_type: "openai-compat".to_string(),
            api_key: "sk-test".to_string(),
            base_url: Some("https://api.test.com".to_string()),
            default_model: "test-model".to_string(),
            models: vec![],
            enabled: false,
        });
        s.active_provider_id = "test".to_string();

        assert!(s.active_provider().is_err());
    }
}
