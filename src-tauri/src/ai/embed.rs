//! 本地 Embedding（fastembed + ONNX）。
//!
//! 模型首次调用时从 HuggingFace 下载（`bge-small-en-v1.5`，~80MB），
//! 之后离线运行。模型经 `OnceLock` 懒加载，进程内只初始化一次。
//! `TextEmbedding::embed` 需要 `&mut self`，故用 `Mutex` 提供可变访问。

use anyhow::{Context, Result};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::sync::{Mutex, OnceLock};

static EMBEDDER: OnceLock<Result<Mutex<TextEmbedding>, String>> = OnceLock::new();

/// 取全局 embedding 模型实例。
fn get() -> Result<&'static Mutex<TextEmbedding>> {
    EMBEDDER
        .get_or_init(|| {
            TextEmbedding::try_new(
                InitOptions::new(EmbeddingModel::BGESmallENV15).with_show_download_progress(true),
            )
            .map(Mutex::new)
            .map_err(|e| e.to_string())
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
