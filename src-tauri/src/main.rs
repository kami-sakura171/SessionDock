// 防止 Windows 发布构建弹出额外控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    session_dock_lib::run()
}
