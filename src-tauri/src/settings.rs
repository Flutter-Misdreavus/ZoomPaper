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

/// 完整应用设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
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
    /// 联网搜索 provider：`none` / `auto` / `deepseek` / `anthropic`（复用对应 API Key）
    pub web_search_provider: String,
    /// 原生搜索用的模型名；None 用 provider 默认（deepseek-v4-flash / llm_model）
    pub web_search_model: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
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
            let had_legacy = self.api_keys.is_some() || self.llm_provider.is_some() || self.llm_model.is_some();
            if self.mineru_api_key.is_empty() {
                if let Some(keys) = &self.api_keys { self.mineru_api_key = keys.mineru.clone(); }
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

    /// 解析联网搜索 provider：返回 `(provider, model)`；不可用时返回 None。
    /// 前端「未配置」提示由 getSettings 的字段自行判断（provider 非 none 且对应 Key 非空）。
    ///
    /// - `deepseek` → 需对应 provider 存在且启用，模型默认 `deepseek-v4-flash`；
    /// - `anthropic` → 需对应 provider 存在且启用，模型默认当前激活 provider 的模型（若类型是 anthropic）否则 `claude-sonnet-4-6`；
    /// - `auto` → 优先 deepseek 再 anthropic（任一可用即可）。
    pub fn web_search_available(&self) -> Option<(String, String)> {
        let provider = self.web_search_provider.to_lowercase();
        let model = |default: &str| {
            self.web_search_model
                .clone()
                .unwrap_or_else(|| default.to_string())
        };

        // 从 providers 中查找 provider
        let find_provider = |id: &str| -> bool {
            self.providers
                .iter()
                .any(|p| p.id == id && p.enabled && !p.api_key.is_empty())
        };

        let candidates: Vec<(&str, bool, String)> = vec![
            (
                "deepseek",
                find_provider("deepseek"),
                model("deepseek-v4-flash"),
            ),
            (
                "anthropic",
                find_provider("anthropic"),
                model(
                    if self
                        .active_provider()
                        .ok()
                        .map(|p| p.provider_type.as_str())
                        == Some("anthropic")
                    {
                        self.active_provider()
                            .ok()
                            .map(|p| p.default_model.as_str())
                            .unwrap_or("claude-sonnet-4-6")
                    } else {
                        "claude-sonnet-4-6"
                    },
                ),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_web_provider_is_auto_and_keys_gate_availability() {
        let mut s = Settings::default();
        assert_eq!(s.web_search_provider, "auto");
        // 无 provider → 不可用
        assert!(s.web_search_available().is_none());

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
        let (provider, _model) = s.web_search_available().unwrap();
        assert_eq!(provider, "deepseek");

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
        let (provider2, _m2) = s2.web_search_available().unwrap();
        assert_eq!(provider2, "anthropic");
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
