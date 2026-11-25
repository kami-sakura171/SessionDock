//! SessionDock 核心逻辑：不依赖 Tauri / WebView2，便于独立扫描、测试与数据对比。
//! 仅桌面端使用；GUI 在 src-tauri 的 session-dock 包里。

pub mod delete;
pub mod sessions;
pub mod store;
