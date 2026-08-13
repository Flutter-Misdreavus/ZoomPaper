//! ZoomPaper 桌面端入口：Tauri 应用装配。

mod ai;
mod commands;
mod db;
mod feynman;
mod fs;
mod rag;
mod settings;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 初始化数据库（建目录 + 建表）并放入应用状态
            let db = db::Db::init()?;
            app.manage(db);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
