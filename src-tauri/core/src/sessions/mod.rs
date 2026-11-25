//! 平台适配器注册表。新增平台只需实现 list() / read(id)，
//! 在这里挂上并补一个 label 条目，上层完全不用改。

pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod cursor;
pub mod deepseek;
pub mod hermes;
pub mod kiro;
pub mod pi;
pub mod vscode;

use crate::store;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use rayon::prelude::*;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub platform: String,
    pub title: String,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: i64,
    pub archived: bool,
    pub account: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub text: String,
    pub timestamp: Option<i64>,
}

impl Message {
    pub fn new(role: &str, text: String, timestamp: Option<i64>) -> Self {
        Self { role: role.to_string(), text, timestamp }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub platform: String,
    pub label: String,
    pub count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionsPayload {
    pub sessions: Vec<Session>,
    pub platforms: Vec<PlatformInfo>,
}

pub struct Adapter {
    pub id: &'static str,
    pub label: &'static str,
    pub list: fn() -> Result<Vec<Session>, String>,
    pub read: fn(&str) -> Result<Vec<Message>, String>,
}

pub const ADAPTERS: &[Adapter] = &[
    Adapter { id: "codex", label: "Codex", list: codex::list, read: codex::read },
    Adapter { id: "claude", label: "Claude Code", list: claude::list, read: claude::read },
    Adapter { id: "cursor", label: "Cursor", list: cursor::list, read: cursor::read },
    Adapter { id: "antigravity", label: "Antigravity", list: antigravity::list, read: antigravity::read },
    Adapter { id: "hermes", label: "Hermes", list: hermes::list, read: hermes::read },
    Adapter { id: "pi", label: "Pi", list: pi::list, read: pi::read },
    Adapter { id: "vscode", label: "VS Code", list: vscode::list, read: vscode::read },
    Adapter { id: "kiro", label: "Kiro", list: kiro::list, read: kiro::read },
    Adapter { id: "deepseek", label: "DeepSeek Harness", list: deepseek::list, read: deepseek::read },
];

pub fn label_of(platform: &str) -> String {
    ADAPTERS
        .iter()
        .find(|a| a.id == platform)
        .map(|a| a.label.to_string())
        .unwrap_or_else(|| platform.to_string())
}

/// 八个平台并发扫描（rayon），平台间互不影响，单个平台失败只记 error
pub fn list_all() -> SessionsPayload {
    let archived = store::archived_map();
    let results: Vec<(String, String, Vec<Session>, Option<String>)> = ADAPTERS
        .par_iter()
        .map(|a| {
            let (rows, error) = match (a.list)() {
                Ok(rows) => (rows, None),
                Err(e) => (Vec::new(), Some(e)),
            };
            (a.id.to_string(), a.label.to_string(), rows, error)
        })
        .collect();

    let mut sessions = Vec::new();
    let mut platforms = Vec::new();
    for (id, label, rows, error) in results {
        let count = rows.len();
        for mut r in rows {
            r.archived = r.archived || archived.contains_key(&store::key_of(&r.platform, &r.id));
            sessions.push(r);
        }
        platforms.push(PlatformInfo { platform: id, label, count, error });
    }

    sessions.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
    SessionsPayload { sessions, platforms }
}

pub fn read(platform: &str, id: &str) -> Result<Vec<Message>, String> {
    let adapter = ADAPTERS
        .iter()
        .find(|a| a.id == platform)
        .ok_or_else(|| format!("暂未支持的平台: {platform}"))?;
    (adapter.read)(id)
}

pub fn export_markdown(platform: &str, id: &str, title: &str) -> Result<String, String> {
    let messages = read(platform, id)?;
    let display_title = if title.is_empty() { id } else { title };
    let mut out = format!(
        "# {display_title}\n\n- 平台: {}\n- 会话 ID: `{id}`\n\n---\n\n",
        label_of(platform)
    );
    for m in messages {
        let who = match m.role.as_str() {
            "user" => "👤 用户",
            "assistant" => "🤖 助手",
            _ => "系统",
        };
        out.push_str(&format!("### {who}\n\n{}\n\n", m.text.trim()));
    }
    Ok(out)
}

/* ---------- 公共工具 ---------- */

pub fn basename(p: &str) -> Option<String> {
    let trimmed = p.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub fn file_stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 与 Node 的 readFileSync(utf8) 行为一致：非法 UTF-8 用 U+FFFD 替换而不是整文件放弃。
/// transcript / jsonl 里偶有二进制片段，严格 UTF-8 读取会丢整个分片。
pub fn read_text_lossy(path: &Path) -> std::io::Result<String> {
    fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn read_text(path: &Path) -> Option<String> {
    read_text_lossy(path).ok()
}

/// JS Date.parse 的主要形态：RFC3339 / ISO，附几种常见兜底格式
pub fn parse_date_ms(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return Some(d.timestamp_millis());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(t, fmt) {
            if let Some(d) = Local.from_local_datetime(&n).single() {
                return Some(d.timestamp_millis());
            }
            return Some(Utc.from_utc_datetime(&n).timestamp_millis());
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        let n = d.and_hms_opt(0, 0, 0)?;
        return Some(Utc.from_utc_datetime(&n).timestamp_millis());
    }
    None
}

static NUMERIC_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\d+(\.\d+)?$").expect("numeric regex"));

/// 统一把秒 / 毫秒 / ISO 字符串转成毫秒时间戳（对齐原版 normalizeTs）
pub fn normalize_ts_str(raw: &str) -> Option<i64> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if NUMERIC_RE.is_match(t) {
        let n: f64 = t.parse().ok()?;
        if !n.is_finite() || n <= 0.0 {
            return None;
        }
        return Some(if n < 1e11 { (n * 1000.0).round() as i64 } else { n.round() as i64 });
    }
    parse_date_ms(t).filter(|v| *v > 0)
}

pub fn normalize_ts_json(v: &Value) -> Option<i64> {
    match v {
        Value::Null => None,
        Value::Number(n) => normalize_ts_str(&n.to_string()),
        Value::String(s) => normalize_ts_str(s),
        _ => None,
    }
}

pub fn db_value_to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(b) => Value::String(String::from_utf8_lossy(b).to_string()),
    }
}

pub fn db_ts(v: ValueRef) -> Option<i64> {
    normalize_ts_json(&db_value_to_json(v))
}

pub fn db_string(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Blob(b) => Some(String::from_utf8_lossy(b).to_string()),
    }
}

pub fn db_bool(v: ValueRef) -> bool {
    match v {
        ValueRef::Integer(i) => i != 0,
        ValueRef::Real(f) => f != 0.0,
        ValueRef::Text(t) => matches!(t, b"1" | b"true" | b"TRUE"),
        _ => false,
    }
}

pub fn json_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 库文件名带版本号（state_5 / thread_history_1），取数字最大的那个
pub fn latest_db(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(i64, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(prefix) || !name.ends_with(".sqlite") {
            continue;
        }
        let mid = &name[prefix.len()..name.len() - ".sqlite".len()];
        let version = mid.parse::<i64>().unwrap_or(0);
        if best.as_ref().map(|(v, _)| version > *v).unwrap_or(true) {
            best = Some((version, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

/// 只读连接 + 可选的临时目录副本。字段顺序即 drop 顺序：先关库再删临时目录。
pub struct DbHandle {
    pub conn: Connection,
    tmp_dir: Option<PathBuf>,
}

impl Drop for DbHandle {
    fn drop(&mut self) {
        if let Some(dir) = self.tmp_dir.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "csm-{tag}-{}-{seq}-{}",
        std::process::id(),
        store::now_ms()
    ))
}

/**
 * 只读打开。若正被客户端占用（WAL 需要写 shm），退化为复制到临时目录再读，
 * 保证绝不触碰正在运行的程序。allow_copy=false 时（Cursor 2GB 大库）直接放弃。
 */
pub fn open_read_only(file: &Path, allow_copy: bool) -> Option<DbHandle> {
    if !file.exists() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if let Ok(conn) = Connection::open_with_flags(file, flags) {
        return Some(DbHandle { conn, tmp_dir: None });
    }
    if !allow_copy {
        return None;
    }
    let dir = temp_dir("db");
    fs::create_dir_all(&dir).ok()?;
    let tmp = dir.join("db.sqlite");
    let ok = (|| {
        fs::copy(file, &tmp).ok()?;
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{}", file.to_string_lossy(), suffix));
            if side.exists() {
                let dst = PathBuf::from(format!("{}{}", tmp.to_string_lossy(), suffix));
                fs::copy(&side, &dst).ok()?;
            }
        }
        Connection::open_with_flags(&tmp, flags).ok()
    })();
    match ok {
        Some(conn) => Some(DbHandle { conn, tmp_dir: Some(dir) }),
        None => {
            let _ = fs::remove_dir_all(&dir);
            None
        }
    }
}

/// 表里的列名集合，老版本缺列时用 null 兜底
pub fn table_columns(conn: &Connection, table: &str) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<usize, String>(1))
        .map_err(|e| e.to_string())?;
    let mut out = std::collections::HashSet::new();
    for r in rows.flatten() {
        out.insert(r);
    }
    Ok(out)
}

pub fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "select name from sqlite_master where type='table' and name = ?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

pub fn collapse_ws(s: &str) -> String {
    static WS: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\s+").expect("ws regex"));
    WS.replace_all(s, " ").trim().to_string()
}

pub fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub fn empty_counts() -> HashMap<String, i64> {
    HashMap::new()
}
