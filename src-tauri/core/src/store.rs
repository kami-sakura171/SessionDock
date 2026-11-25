//! 应用自身的元数据（不写任何平台的数据）：
//!   - archived: 本地归档标记，用于「仅归档可删」这条规则
//!   - trash:    隔离区清单
//! 数据根目录与 Electron 版完全一致（%APPDATA%\session-dock），实现无缝兼容。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn app_data_base() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
}

pub fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join("AppData").join("Local"))
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("C:\\"))
}

fn legacy_root() -> PathBuf {
    app_data_base().join("chat-session-manager")
}

fn new_root() -> PathBuf {
    // 仅测试用：允许把数据目录指到临时目录，避免碰真实用户数据
    if let Some(p) = std::env::var_os("SESSIONDOCK_DATA_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    app_data_base().join("session-dock")
}

pub fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else if src.is_file() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

static MIGRATED: Mutex<bool> = Mutex::new(false);

/// 首次启动自动迁移：老目录存在且新目录还没有 meta.json 时整体搬过来
fn migrate_legacy_root() {
    if std::env::var_os("SESSIONDOCK_DATA_DIR").is_some() {
        return;
    }
    let mut done = match MIGRATED.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if *done {
        return;
    }
    *done = true;
    let old_dir = legacy_root();
    let cur_dir = new_root();
    if !old_dir.exists() || cur_dir.join("meta.json").exists() {
        return;
    }
    let result = (|| -> std::io::Result<()> {
        fs::create_dir_all(&cur_dir)?;
        for entry in [
            "meta.json",
            "trash",
            "exports",
            "cursor-titles.json",
            "pi-index.json",
            "sessions-cache.json",
            "codex-rollout-index.json",
        ] {
            let src = old_dir.join(entry);
            let dst = cur_dir.join(entry);
            if src.exists() && !dst.exists() {
                copy_recursive(&src, &dst)?;
            }
        }
        // 同步更新 meta.json 里隔离区记录的目录路径
        let mf = cur_dir.join("meta.json");
        if mf.exists() {
            let raw = fs::read_to_string(&mf)?;
            if let Ok(mut meta) = serde_json::from_str::<Value>(&raw) {
                let old_prefix = old_dir.to_string_lossy().to_string();
                let new_prefix = cur_dir.to_string_lossy().to_string();
                if let Some(trash) = meta.get_mut("trash").and_then(Value::as_array_mut) {
                    for t in trash.iter_mut() {
                        if let Some(dir) = t.get("dir").and_then(Value::as_str) {
                            if dir.starts_with(&old_prefix) {
                                let replaced = format!("{}{}", new_prefix, &dir[old_prefix.len()..]);
                                t["dir"] = Value::String(replaced);
                            }
                        }
                    }
                }
                fs::write(&mf, serde_json::to_string_pretty(&meta)?)?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        // 迁移失败时不阻塞启动
    }
}

pub fn root() -> PathBuf {
    migrate_legacy_root();
    new_root()
}

pub fn trash_root() -> PathBuf {
    root().join("trash")
}

fn meta_file() -> PathBuf {
    root().join("meta.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ArchivedEntry {
    #[serde(default)]
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub trash_id: String,
    pub platform: String,
    pub id: String,
    pub title: String,
    pub deleted_at: i64,
    pub dir: String,
    pub kind: String,
    #[serde(default)]
    pub original_path: Option<String>,
    /// 兼容老记录里的未知字段，写回时不丢数据
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Meta {
    #[serde(default)]
    archived: HashMap<String, ArchivedEntry>,
    #[serde(default)]
    trash: Vec<TrashItem>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// meta.json 的读-改-写必须串行，否则并发命令会互相覆盖
static META_LOCK: Mutex<()> = Mutex::new(());

fn read_meta() -> Meta {
    fs::read_to_string(meta_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Meta>(&s).ok())
        .unwrap_or_default()
}

fn write_meta(meta: &Meta) -> Result<(), String> {
    let dir = root();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(meta_file(), body).map_err(|e| e.to_string())
}

pub fn key_of(platform: &str, id: &str) -> String {
    format!("{platform}:{id}")
}

pub fn archived_map() -> HashMap<String, ArchivedEntry> {
    let _guard = META_LOCK.lock().ok();
    read_meta().archived
}

pub fn is_archived(platform: &str, id: &str) -> bool {
    let _guard = META_LOCK.lock().ok();
    read_meta().archived.contains_key(&key_of(platform, id))
}

pub fn set_archived(platform: &str, id: &str, value: bool) -> Result<bool, String> {
    let _guard = META_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_meta();
    let k = key_of(platform, id);
    if value {
        meta.archived.insert(k, ArchivedEntry { at: now_ms() });
    } else {
        meta.archived.remove(&k);
    }
    write_meta(&meta)?;
    Ok(value)
}

/// 批量归档：只读一次 meta.json，写一次盘
pub fn set_archived_many(items: &[(String, String)], value: bool) -> Result<usize, String> {
    let _guard = META_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_meta();
    for (platform, id) in items {
        let k = key_of(platform, id);
        if value {
            meta.archived.insert(k, ArchivedEntry { at: now_ms() });
        } else {
            meta.archived.remove(&k);
        }
    }
    write_meta(&meta)?;
    Ok(items.len())
}

pub fn new_trash_dir(platform: &str, id: &str) -> Result<PathBuf, String> {
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();
    let prefix: String = id.chars().take(8).collect();
    let dir = trash_root().join(format!("{stamp}_{platform}_{prefix}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn add_trash(record: TrashItem) -> Result<(), String> {
    let _guard = META_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_meta();
    meta.trash.insert(0, record);
    write_meta(&meta)
}

pub fn list_trash() -> Vec<TrashItem> {
    let _guard = META_LOCK.lock().ok();
    read_meta().trash
}

pub fn drop_trash_record(trash_id: &str) -> Result<Option<TrashItem>, String> {
    let _guard = META_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_meta();
    let item = meta.trash.iter().find(|t| t.trash_id == trash_id).cloned();
    meta.trash.retain(|t| t.trash_id != trash_id);
    write_meta(&meta)?;
    Ok(item)
}

/// 递归统计目录体积，用于「一键清空」时告知将释放多少空间
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let full = entry.path();
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    total += dir_size(&full);
                } else if let Ok(md) = entry.metadata() {
                    total += md.len();
                }
            }
        }
    }
    total
}

/// 清空隔离区：先算体积再删，返回清掉了多少
pub fn clear_trash() -> Result<(usize, u64), String> {
    let items = list_trash();
    let mut bytes = 0;
    for it in &items {
        bytes += dir_size(Path::new(&it.dir));
    }
    for it in &items {
        remove_trash_dir(&it.dir);
    }
    let _guard = META_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_meta();
    meta.trash.clear();
    write_meta(&meta)?;
    Ok((items.len(), bytes))
}

/// 只删除隔离区内部的目录，路径必须落在 trash 根目录之下，避免误删外部数据
pub fn remove_trash_dir(dir: &str) {
    let path = PathBuf::from(dir);
    let trash = trash_root();
    if !path.starts_with(&trash) {
        app_log(&format!("refuse to remove non-trash dir: {dir}"));
        return;
    }
    let _ = fs::remove_dir_all(&path);
}

fn snapshot_file() -> PathBuf {
    root().join("sessions-cache.json")
}

pub fn read_snapshot_json() -> Option<Value> {
    let raw = fs::read_to_string(snapshot_file()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    if v.get("sessions").and_then(Value::as_array).is_some()
        && v.get("platforms").and_then(Value::as_array).is_some()
    {
        Some(v)
    } else {
        None
    }
}

pub fn write_snapshot_json(data: &Value) {
    let dir = root();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut obj = data.clone();
    if let Some(map) = obj.as_object_mut() {
        map.insert("savedAt".to_string(), Value::from(now_ms()));
    }
    if let Ok(body) = serde_json::to_string(&obj) {
        let tmp = snapshot_file().with_extension("json.tmp");
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, snapshot_file());
        }
    }
}

/// 读取任意 JSON 缓存文件（cursor-titles / pi-index / codex-rollout-index）
pub fn read_json_cache(name: &str) -> Value {
    fs::read_to_string(root().join(name))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

pub fn write_json_cache(name: &str, value: &Value) {
    let dir = root();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(body) = serde_json::to_string(value) {
        let _ = fs::write(dir.join(name), body);
    }
}

pub fn app_log(msg: &str) {
    let file = root().join("app.log");
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = format!("[{}] {}\n", chrono::Utc::now().to_rfc3339(), msg);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

/// 去掉 Windows 的 \\?\ 扩展路径前缀，和原版保持一致
pub fn strip_verbatim_prefix(p: &str) -> String {
    p.strip_prefix("\\\\?\\").unwrap_or(p).to_string()
}

pub fn mtime_ms(path: &Path) -> Option<f64> {
    let md = fs::metadata(path).ok()?;
    let t = md.modified().ok()?;
    let d = t.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

pub fn birthtime_ms(path: &Path) -> Option<f64> {
    let md = fs::metadata(path).ok()?;
    let t = md.created().ok()?;
    let d = t.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

pub fn same_mtime(a: f64, b: f64) -> bool {
    // 文件系统时间戳转换存在微小浮点误差，容差 0.01ms 内视为未变化
    (a - b).abs() < 0.01
}
