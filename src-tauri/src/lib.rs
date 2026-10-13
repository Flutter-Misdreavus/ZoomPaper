//! ZoomPaper 桌面端入口：Tauri 应用装配。

mod agent;
mod ai;
mod blog;
mod commands;
mod companion;
mod connector;
mod db;
mod feynman;
mod fs;
mod jobs;
mod publication;
mod qa;
mod quiz;
mod rag;
mod settings;
mod storage;
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
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 初始化数据库（建目录 + 建表）并放入应用状态
            if let Err(error) = storage::apply_pending() {
                eprintln!("恢复备份失败：{error}");
                if let Ok(data) = settings::app_data_dir() {
                    let _ = std::fs::write(data.join("restore-error.txt"), error.to_string());
                    let _ = std::fs::remove_file(data.join("restore-request.json"));
                }
            }
            let db = db::Db::init()?;
            app.manage(db);
            if let (Some(main), Some(companion)) = (
                app.get_webview_window("main"),
                app.get_webview_window("companion"),
            ) {
                if let (Ok(position), Ok(size), Ok(scale)) = (
                    main.outer_position(),
                    main.outer_size(),
                    main.scale_factor(),
                ) {
                    let _ = companion.set_position(tauri::PhysicalPosition::new(
                        position.x + size.width as i32 - (360.0 * scale) as i32,
                        position.y + (60.0 * scale) as i32,
                    ));
                }
            }
            companion::start(app.handle().clone());
            jobs::start(app.handle().clone());
            connector::start(app.handle().clone());
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            #[cfg(target_os = "macos")]
            enable_pinch_zoom(app);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(companion) = window.app_handle().get_webview_window("companion") {
                    let _ = companion.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            companion::companion_regions,
            companion::companion_press,
            companion::companion_release,
            commands::get_settings,
            commands::update_settings,
            commands::get_themes_dir,
            commands::list_custom_themes,
            commands::enqueue_metadata_translations,
            jobs::claim_frontend_translation,
            jobs::finish_frontend_translation,
            storage::export_library_backup,
            storage::stage_library_restore,
            storage::take_restored_preferences,
            storage::relocate_library,
            storage::clear_library_cache,
            storage::prepare_browser_extension,
            storage::library_storage_path,
            connector::browser_extension_status,
            commands::add_provider,
            commands::update_provider,
            commands::delete_provider,
            commands::set_active_provider,
            commands::list_papers,
            commands::get_paper,
            commands::open_paper,
            commands::set_reading_status,
            commands::export_notes,
            commands::get_paper_md,
            commands::import_pdf,
            commands::import_browser_download,
            commands::import_pdf_url,
            commands::parse_pdf,
            jobs::list_jobs,
            jobs::cancel_job,
            jobs::retry_job,
            commands::translate_paper_metadata,
            commands::refresh_paper_publication,
            commands::delete_paper,
            commands::index_paper,
            commands::reindex_all_papers,
            commands::search,
            commands::keyword_search,
            commands::generate_blog,
            commands::translate_chunk,
            commands::translate_selection,
            commands::save_translation,
            commands::get_translation,
            commands::get_annotations,
            commands::save_annotations,
            commands::list_folders,
            commands::create_folder,
            commands::update_folder,
            commands::delete_folder,
            commands::add_papers_to_folder,
            commands::remove_papers_from_folder,
            commands::rename_paper,
            commands::set_paper_status,
            commands::set_paper_starred,
            commands::restore_paper,
            commands::permanently_delete_paper,
            commands::empty_trash,
            commands::ask_app_help,
            commands::add_reading_time,
            commands::mark_paper_read,
            commands::create_reading_plan,
            commands::list_reading_plans,
            commands::update_reading_plan,
            commands::delete_reading_plan,
            commands::add_paper_to_plan,
            commands::remove_paper_from_plan,
            commands::set_plan_item_due,
            commands::timeline_stats,
            commands::ask_question,
            commands::ask_question_reply,
            commands::cancel_generation,
            commands::list_conversations,
            commands::get_conversation,
            commands::delete_conversation,
            commands::feynman_turn,
            commands::feynman_start,
            commands::feynman_confirm_plan,
            commands::feynman_quiz,
            commands::feynman_judge,
            commands::feynman_next,
            commands::feynman_review,
            commands::get_feynman_conversation,
            commands::quiz_sections,
            commands::quiz_generate,
            commands::quiz_submit_answer,
            commands::quiz_grade_all,
            commands::quiz_list,
            commands::quiz_get,
            commands::quiz_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
