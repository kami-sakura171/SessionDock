pub mod commands;

// 核心逻辑在独立的 session-dock-core crate（无 GUI 依赖），这里再导出保持原有路径
pub use session_dock_core::{delete, sessions, store};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ScanManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::sessions_list,
            commands::sessions_read,
            commands::sessions_export,
            commands::sessions_archive,
            commands::sessions_archive_many,
            commands::sessions_export_many,
            commands::sessions_delete,
            commands::sessions_delete_many,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_purge_all,
            commands::file_export,
            commands::file_reveal,
            commands::fs_list_dir,
            commands::fs_mkdir,
        ])
        // 自绘标题栏窗口先隐藏，页面加载完成再显示，避免白屏闪烁
        .on_page_load(|window, _payload| {
            let _ = window.show();
        })
        .run(tauri::generate_context!())
        .expect("error while running SessionDock");
}
