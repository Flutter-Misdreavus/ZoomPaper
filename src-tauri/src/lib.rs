//! ZoomPaper 桌面端入口：Tauri 应用装配。

mod ai;
mod blog;
mod commands;
mod db;
mod feynman;
mod fs;
mod qa;
mod rag;
mod settings;
mod translate;

use tauri::Manager;

/// 启用 WKWebView 的原生捏合放大，使双指捏合以 `gesturestart/change/end` 事件浮出，
/// 前端再 `preventDefault()` 抑制原生整页缩放并用 `e.scale` 驱动自有缩放。
#[cfg(target_os = "macos")]
fn enable_pinch_zoom(app: &tauri::App) {
    use objc2_web_kit::WKWebView;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.with_webview(|wv| unsafe {
            let view: &WKWebView = &*wv.inner().cast();
            view.setAllowsMagnification(true);
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 初始化数据库（建目录 + 建表）并放入应用状态
            let db = db::Db::init()?;
            app.manage(db);
            #[cfg(target_os = "macos")]
            enable_pinch_zoom(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::list_papers,
            commands::get_paper,
            commands::get_paper_md,
            commands::import_pdf,
            commands::parse_pdf,
            commands::delete_paper,
            commands::index_paper,
            commands::search,
            commands::generate_blog,
            commands::translate_chunk,
            commands::save_translation,
            commands::get_translation,
            commands::ask_question,
            commands::list_conversations,
            commands::get_conversation,
            commands::feynman_turn,
            commands::feynman_start,
            commands::feynman_review,
            commands::get_feynman_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
