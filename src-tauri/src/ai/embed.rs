//! 本地 Embedding（fastembed + ONNX，bge-small-en-v1.5）。
//!
//! 模型文件保存在 `<app_data>/models/bge-small-en-v1.5/`，首次使用时从
//! hf-mirror 镜像下载（HuggingFace 直连在国内受限），之后离线加载。
//! 模型经 `OnceLock` 懒加载，进程内只初始化一次。
//! `TextEmbedding::embed` 需要 `&mut self`，故用 `Mutex` 提供可变访问。

use anyhow::{Context, Result};
use fastembed::{
    EmbeddingModel, InitOptions, InitOptionsUserDefined, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 模型仓库与文件清单（对应 fastembed 的 `Xenova/bge-small-en-v1.5`）。
const MODEL_REPO: &str = "Xenova/bge-small-en-v1.5";
const MIRROR_BASE: &str = "https://hf-mirror.com";
const FILES: &[(&str, &str)] = &[
    ("onnx/model.onnx", "model.onnx"),
    ("tokenizer.json", "tokenizer.json"),
    ("config.json", "config.json"),
    ("special_tokens_map.json", "special_tokens_map.json"),
    ("tokenizer_config.json", "tokenizer_config.json"),
];

static EMBEDDER: OnceLock<Result<Mutex<TextEmbedding>, String>> = OnceLock::new();

/// 模型目录：`<app_data>/models/bge-small-en-v1.5/`
fn model_dir() -> Result<PathBuf> {
    Ok(crate::settings::app_data_dir()?.join("models/bge-small-en-v1.5"))
}

/// 确保模型文件已下载（缺失则从镜像下载）。
fn ensure_model_downloaded() -> Result<PathBuf> {
    let dir = model_dir()?;
    if FILES.iter().all(|(_, dst)| dir.join(dst).exists()) {
        return Ok(dir);
    }

    std::fs::create_dir_all(&dir).context("创建模型目录失败")?;
    let client = reqwest::blocking::Client::new();
    for (src, dst) in FILES {
        let url = format!("{MIRROR_BASE}/{MODEL_REPO}/resolve/main/{src}");
        eprintln!("下载 embedding 模型: {src}");
        let resp = client
            .get(&url)
            .send()
            .with_context(|| format!("下载 {src} 失败"))?;
        let status = resp.status();
        if !status.is_success() {
            anyhow::bail!("下载 {src} 返回 {status}");
        }
        let bytes = resp.bytes().context("读取模型响应失败")?;
        std::fs::write(dir.join(dst), bytes).with_context(|| format!("写入 {dst} 失败"))?;
    }
    Ok(dir)
}

/// 从本地文件加载模型字节。
fn load_local_model(dir: &std::path::Path) -> Result<UserDefinedEmbeddingModel> {
    let read = |name: &str| {
        std::fs::read(dir.join(name)).with_context(|| format!("读取模型文件 {name} 失败"))
    };
    Ok(UserDefinedEmbeddingModel::new(
        read("model.onnx")?,
        TokenizerFiles {
            tokenizer_file: read("tokenizer.json")?,
            config_file: read("config.json")?,
            special_tokens_map_file: read("special_tokens_map.json")?,
            tokenizer_config_file: read("tokenizer_config.json")?,
        },
    ))
}

/// 取全局 embedding 模型实例。
fn get() -> Result<&'static Mutex<TextEmbedding>> {
    EMBEDDER
        .get_or_init(|| {
            let loaded = ensure_model_downloaded()
                .and_then(|dir| load_local_model(&dir))
                .and_then(|m| {
                    TextEmbedding::try_new_from_user_defined(
                        m,
                        InitOptionsUserDefined::default(),
                    )
                })
                // 本地加载失败时回退到内置下载（走 hf-mirror）
                .or_else(|local_err| {
                    eprintln!("本地模型加载失败，回退内置下载: {local_err}");
                    if std::env::var_os("HF_ENDPOINT").is_none() {
                        std::env::set_var("HF_ENDPOINT", MIRROR_BASE);
                    }
                    TextEmbedding::try_new(
                        InitOptions::new(EmbeddingModel::BGESmallENV15)
                            .with_show_download_progress(true),
                    )
                })
                .map(Mutex::new)
                .map_err(|e| e.to_string());
            loaded
        })
        .as_ref()
        .map_err(|e| anyhow::anyhow!("embedding 模型初始化失败: {e}"))
}

/// 批量向量化文本。输出维度与模型绑定（bge-small-en-v1.5 = 384）。
pub fn embed_texts(texts: &[&str]) -> Result<Vec<Vec<f32>>> {
    let model = get()?;
    let mut model = model.lock().expect("embedding 锁被毒化");
    model
        .embed(texts.to_vec(), None)
        .context("向量化失败")
}

/// 向量化单条查询文本。
pub fn embed_query(text: &str) -> Result<Vec<f32>> {
    let mut out = embed_texts(&[text])?;
    out.pop().context("embedding 返回为空")
}
