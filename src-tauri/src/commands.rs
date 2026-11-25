//! Tauri IPC 命令：与前端 src/api.ts 一一对应。
//! 扫描调度对齐 Electron 主进程：快照秒开 + 后台补扫 + 数据代数作废旧结果 + 单flight去重。

use crate::delete;
use crate::sessions::{self, Session, SessionsPayload};
use crate::store::{self, TrashItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct ScanInner {
    pub data_gen: u64,
    pub latest: Option<SessionsPayload>,
    pub last_scan_at: i64,
    pub last_scan_gen: i64,
    pub scanning: bool,
}

#[derive(Default)]
pub struct ScanManager {
    pub mu: Mutex<ScanInner>,
    pub cv: Condvar,
}

impl ScanManager {
    pub fn new() -> Self {
        // 预热上次扫描的快照，窗口加载期间就能秒开列表
        let latest = store::read_snapshot_json().and_then(|v| serde_json::from_value(v).ok());
        Self {
            mu: Mutex::new(ScanInner {
                latest,
                last_scan_gen: -1,
                ..Default::default()
            }),
            cv: Condvar::new(),
        }
    }

    /// 数据变了只作废，不立刻重扫；下次真正需要列表时再算一次
    pub fn invalidate(&self) {
        if let Ok(mut g) = self.mu.lock() {
            g.data_gen += 1;
        }
    }

    fn snapshot(&self) -> Option<SessionsPayload> {
        self.mu.lock().ok()?.latest.clone()
    }
}

pub fn run_scan(app: &AppHandle) -> SessionsPayload {
    let mgr = app.state::<ScanManager>();
    loop {
        let gen = {
            let mut g = match mgr.mu.lock() {
                Ok(g) => g,
                Err(_) => return SessionsPayload::default(),
            };
            if g.scanning {
                // 已有扫描在跑，等它的结果，避免重复扫两遍
                let mut g = match mgr.cv.wait(g) {
                    Ok(g) => g,
                    Err(_) => return SessionsPayload::default(),
                };
                if let Some(d) = &g.latest {
                    return d.clone();
                }
                g.scanning = false;
                drop(g);
                continue;
            }
            let now = store::now_ms();
            // 2 秒内同代数的重复请求直接复用结果，避免启动时被调用两次而扫两遍
            if let Some(d) = &g.latest {
                if g.last_scan_gen == g.data_gen as i64 && now - g.last_scan_at < 2000 {
                    return d.clone();
                }
            }
            g.scanning = true;
            g.data_gen
        };

        let data = sessions::list_all();
        if let Ok(v) = serde_json::to_value(&data) {
            store::write_snapshot_json(&v);
        }

        let mut g = match mgr.mu.lock() {
            Ok(g) => g,
            Err(_) => return data,
        };
        g.scanning = false;
        let stale = g.data_gen != gen;
        if !stale {
            g.latest = Some(data.clone());
            g.last_scan_at = store::now_ms();
            g.last_scan_gen = gen as i64;
        }
        mgr.cv.notify_all();
        drop(g);

        if stale {
            // 扫描期间有增删改，重扫一次再给结果
            continue;
        }
        store::app_log(&format!("scan ok gen={gen} n={}", data.sessions.len()));
        let _ = app.emit("sessions:updated", &data);
        return data;
    }
}

#[tauri::command(async)]
pub fn sessions_list(app: AppHandle, force: Option<bool>) -> Result<SessionsPayload, String> {
    let force = force.unwrap_or(false);
    let mgr = app.state::<ScanManager>();
    if !force {
        if let Some(snap) = mgr.snapshot() {
            // 先返回快照秒开，同时错峰后台刷新（避免与首屏渲染抢 CPU/磁盘）
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(350));
                run_scan(&app2);
            });
            return Ok(snap);
        }
    }
    Ok(run_scan(&app))
}

#[tauri::command(async)]
pub fn sessions_read(platform: String, id: String) -> Result<Vec<sessions::Message>, String> {
    sessions::read(&platform, &id)
}

#[tauri::command(async)]
pub fn sessions_export(platform: String, id: String, title: String) -> Result<String, String> {
    sessions::export_markdown(&platform, &id, &title)
}

#[tauri::command(async)]
pub fn sessions_archive(app: AppHandle, platform: String, id: String, value: bool) -> Result<bool, String> {
    let r = store::set_archived(&platform, &id, value)?;
    app.state::<ScanManager>().invalidate();
    Ok(r)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub platform: String,
    pub id: String,
}

#[tauri::command(async)]
pub fn sessions_archive_many(app: AppHandle, items: Vec<ItemRef>, value: bool) -> Result<usize, String> {
    let pairs: Vec<(String, String)> = items.into_iter().map(|i| (i.platform, i.id)).collect();
    let n = store::set_archived_many(&pairs, value)?;
    app.state::<ScanManager>().invalidate();
    Ok(n)
}

/* ---------- 导出 ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManyResult {
    pub ok: usize,
    pub fail: usize,
    pub dir: String,
}

fn export_dir() -> PathBuf {
    store::root().join("exports")
}

fn safe_name(s: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"[\\/:*?"<>|\r\n\t]+"#).expect("safe name regex")
    });
    let cleaned = RE.replace_all(if s.is_empty() { "session" } else { s }, "_");
    sessions::take_chars(&cleaned, 60)
}

/// 导出到指定目录或默认导出目录；重名时自动加时间戳
fn write_export(platform: &str, title: &str, content: &str, target_dir: Option<PathBuf>) -> Result<ExportResult, String> {
    let dir = target_dir.unwrap_or_else(export_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Utc::now().format("%Y-%m-%d-%H-%M").to_string();
    let file = dir.join(format!("{}_{platform}_{stamp}.md", safe_name(title)));
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(ExportResult {
        path: file.to_string_lossy().to_string(),
        bytes: content.len(),
    })
}

fn resolve_path(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir().map_err(|e| e.to_string())?.join(path))
    }
}

#[tauri::command(async)]
pub fn file_export(
    platform: String,
    id: String,
    title: String,
    target_path: Option<String>,
) -> Result<ExportResult, String> {
    let md = sessions::export_markdown(&platform, &id, &title)?;
    if let Some(tp) = target_path.filter(|s| !s.trim().is_empty()) {
        let resolved = resolve_path(tp.trim())?;
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&resolved, &md).map_err(|e| e.to_string())?;
        return Ok(ExportResult {
            path: resolved.to_string_lossy().to_string(),
            bytes: md.len(),
        });
    }
    write_export(&platform, &title, &md, None)
}

#[tauri::command(async)]
pub fn sessions_export_many(items: Vec<Session>, target_dir: Option<String>) -> Result<ExportManyResult, String> {
    let out_dir = match target_dir.filter(|s| !s.trim().is_empty()) {
        Some(d) => resolve_path(d.trim())?,
        None => export_dir(),
    };
    let mut ok = 0;
    let mut fail = 0;
    for it in &items {
        let attempt = (|| -> Result<(), String> {
            let md = sessions::export_markdown(&it.platform, &it.id, &it.title)?;
            write_export(&it.platform, &it.title, &md, Some(out_dir.clone()))?;
            Ok(())
        })();
        match attempt {
            Ok(_) => ok += 1,
            Err(_) => fail += 1,
        }
    }
    Ok(ExportManyResult {
        ok,
        fail,
        dir: out_dir.to_string_lossy().to_string(),
    })
}

/* ---------- 删除 ---------- */

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOptions {
    pub export_first: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub record: TrashItem,
    pub exported: Option<ExportResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteManyResult {
    pub deleted: usize,
    pub skipped: usize,
    pub exported: usize,
    pub errors: Vec<String>,
}

#[tauri::command(async)]
pub fn sessions_delete(
    app: AppHandle,
    platform: String,
    id: String,
    session: Session,
    options: Option<DeleteOptions>,
) -> Result<DeleteResult, String> {
    let archived = store::is_archived(&platform, &id) || session.archived;
    if !archived {
        return Err("仅允许删除已归档的会话".to_string());
    }

    let export_first = options.and_then(|o| o.export_first).unwrap_or(false);
    let mut exported = None;
    if export_first {
        let md = sessions::export_markdown(&platform, &id, &session.title)?;
        exported = Some(write_export(&platform, &session.title, &md, None)?);
    }

    let record = delete::remove(&platform, &id, &session)?;
    store::set_archived(&platform, &id, false)?;
    app.state::<ScanManager>().invalidate();
    Ok(DeleteResult { record, exported })
}

#[tauri::command(async)]
pub fn sessions_delete_many(
    app: AppHandle,
    items: Vec<Session>,
    options: Option<DeleteOptions>,
) -> Result<DeleteManyResult, String> {
    let export_first = options.and_then(|o| o.export_first).unwrap_or(false);
    let mut deleted = 0;
    let mut skipped = 0;
    let mut exported = 0;
    let mut errors = Vec::new();

    for it in &items {
        let archived = store::is_archived(&it.platform, &it.id) || it.archived;
        if !archived {
            skipped += 1;
            continue;
        }
        let attempt = (|| -> Result<(), String> {
            if export_first {
                let md = sessions::export_markdown(&it.platform, &it.id, &it.title)?;
                write_export(&it.platform, &it.title, &md, None)?;
            }
            delete::remove(&it.platform, &it.id, it)?;
            store::set_archived(&it.platform, &it.id, false)?;
            Ok(())
        })();
        match attempt {
            Ok(_) => {
                if export_first {
                    exported += 1;
                }
                deleted += 1;
            }
            Err(e) => errors.push(format!("{}: {e}", it.title)),
        }
    }

    app.state::<ScanManager>().invalidate();
    Ok(DeleteManyResult { deleted, skipped, exported, errors })
}

/* ---------- 隔离区 ---------- */

#[tauri::command(async)]
pub fn trash_list() -> Result<Vec<TrashItem>, String> {
    Ok(store::list_trash())
}

#[tauri::command(async)]
pub fn trash_restore(app: AppHandle, trash_id: String) -> Result<bool, String> {
    let ok = delete::restore(&trash_id)?;
    app.state::<ScanManager>().invalidate();
    Ok(ok)
}

#[tauri::command(async)]
pub fn trash_purge(trash_id: String) -> Result<bool, String> {
    delete::purge(&trash_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTrashResult {
    pub count: usize,
    pub bytes: u64,
}

#[tauri::command(async)]
pub fn trash_purge_all() -> Result<ClearTrashResult, String> {
    let (count, bytes) = store::clear_trash()?;
    Ok(ClearTrashResult { count, bytes })
}

/* ---------- 文件与目录 ---------- */

#[tauri::command(async)]
pub fn file_reveal(file_path: Option<String>) -> Result<bool, String> {
    let existing = file_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| p.exists());
    match existing {
        Some(p) => {
            let _ = std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", p.to_string_lossy()))
                .spawn();
        }
        None => {
            let dir = export_dir();
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
        }
    }
    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub current: String,
    pub parent: Option<String>,
    pub items: Vec<DirItem>,
    pub shortcuts: Vec<Shortcut>,
    pub drives: Vec<String>,
}

fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for c in b'C'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if Path::new(&root).exists() {
            drives.push(root);
        }
    }
    drives
}

#[tauri::command(async)]
pub fn fs_list_dir(app: AppHandle, dir_path: Option<String>) -> Result<DirListing, String> {
    let exp_dir = export_dir();
    fs::create_dir_all(&exp_dir).map_err(|e| e.to_string())?;

    let mut target = exp_dir.clone();
    if let Some(p) = dir_path.filter(|s| !s.trim().is_empty()) {
        let candidate = resolve_path(p.trim())?;
        if !candidate.exists() {
            return Err(format!("路径不存在：{}", candidate.to_string_lossy()));
        }
        target = candidate;
    }
    let current = if target.is_dir() {
        target.clone()
    } else {
        target.parent().map(|p| p.to_path_buf()).unwrap_or(target.clone())
    };
    let parent = current.parent().map(|p| p.to_string_lossy().to_string());

    let entries = fs::read_dir(&current).map_err(|e| format!("无法读取目录：{e}"))?;
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('$') || name == "System Volume Information" {
            continue;
        }
        let full = entry.path();
        let is_dir = full.is_dir();
        if !is_dir && !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        items.push(DirItem {
            name,
            path: full.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { md.len() },
            mtime: store::mtime_ms(&full).map(|v| v as i64),
        });
    }
    items.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });

    let mut shortcuts = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push_sc = |label: &str, path: Option<PathBuf>, shortcuts: &mut Vec<Shortcut>| {
        if let Some(p) = path {
            let s = p.to_string_lossy().to_string();
            if !s.is_empty() && p.exists() && seen.insert(s.clone()) {
                shortcuts.push(Shortcut { label: label.to_string(), path: s });
            }
        }
    };
    push_sc("默认导出目录", Some(exp_dir), &mut shortcuts);
    push_sc("桌面", app.path().desktop_dir().ok(), &mut shortcuts);
    push_sc("文档", app.path().document_dir().ok(), &mut shortcuts);
    push_sc("下载", app.path().download_dir().ok(), &mut shortcuts);

    Ok(DirListing {
        current: current.to_string_lossy().to_string(),
        parent,
        items,
        shortcuts,
        drives: get_drives(),
    })
}

#[tauri::command(async)]
pub fn fs_mkdir(parent_dir: String, name: String) -> Result<String, String> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"[\\/:*?"<>|\r\n\t]+"#).expect("mkdir name regex")
    });
    let clean = RE.replace_all(&name, "").trim().to_string();
    if clean.is_empty() {
        return Err("文件夹名称不能为空".to_string());
    }
    let full = resolve_path(&parent_dir)?.join(&clean);
    fs::create_dir_all(&full).map_err(|e| e.to_string())?;
    Ok(full.to_string_lossy().to_string())
}

/// 避免未使用告警：Value 在快照兼容逻辑里保留
#[allow(dead_code)]
fn _assert_types(_: &Value) {}
