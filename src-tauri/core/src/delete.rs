//! 安全删除与隔离区：
//!   - 仅允许删除已归档的会话（上层 commands 强制校验）
//!   - 修改平台数据库前先检测对应进程，运行中直接拒绝
//!   - 删除前把数据库行（BLOB 用 base64）或原始文件完整备份到 trash/<时间戳>_<平台>_<id前缀>/

use crate::sessions::{codex, cursor, hermes, Session};
use crate::store::{self, TrashItem};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 平台进程在跑就不动它的库，避免写入被覆盖或把库写坏
pub fn process_running(image: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = Command::new("tasklist.exe")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        return match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .to_lowercase()
                .contains(&image.to_lowercase()),
            Err(_) => false,
        };
    }
    #[cfg(not(windows))]
    {
        let _ = image;
        false
    }
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) => match o.get("__b64").and_then(Value::as_str) {
            Some(b64) => B64.decode(b64).map(SqlValue::Blob).unwrap_or(SqlValue::Null),
            None => SqlValue::Null,
        },
        Value::Array(_) => SqlValue::Null,
    }
}

fn from_sql(v: &rusqlite::types::Value) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::from(*i),
        SqlValue::Real(f) => Value::from(*f),
        SqlValue::Text(s) => Value::String(s.clone()),
        SqlValue::Blob(b) => {
            let mut o = Map::new();
            o.insert("__b64".to_string(), Value::String(B64.encode(b)));
            Value::Object(o)
        }
    }
}

fn dump_table(conn: &Connection, table: &str, filter: &str, params: &[Value]) -> Result<Value, String> {
    let cols: Vec<String> = {
        let mut stmt = conn
            .prepare(&format!("pragma table_info({table})"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<usize, String>(1))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };

    let sql = format!("select * from {table} where {filter}");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let count = cols.len();
    let rows = stmt
        .query_map(params_from_iter(params.iter().map(to_sql)), |row| {
            let mut vals = Vec::with_capacity(count);
            for i in 0..count {
                let v = row.get::<usize, SqlValue>(i)?;
                vals.push(from_sql(&v));
            }
            Ok(vals)
        })
        .map_err(|e| e.to_string())?;
    let mut out_rows = Vec::new();
    for r in rows {
        out_rows.push(Value::Array(r.map_err(|e| e.to_string())?));
    }

    Ok(serde_json::json!({
        "table": table,
        "cols": cols,
        "rows": out_rows,
    }))
}

fn restore_table(conn: &Connection, dump: &Value) -> Result<(), String> {
    let table = dump.get("table").and_then(Value::as_str).unwrap_or("");
    let cols: Vec<String> = dump
        .get("cols")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if table.is_empty() || cols.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; cols.len()].join(",");
    let sql = format!(
        "insert or replace into {table} ({}) values ({placeholders})",
        cols.join(",")
    );
    let rows = dump.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    for row in rows {
        let vals = row.as_array().cloned().unwrap_or_default();
        stmt.execute(params_from_iter(vals.iter().map(to_sql)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn open_rw(file: &Path) -> Result<Connection, String> {
    Connection::open(file).map_err(|e| format!("{}: {e}", file.to_string_lossy()))
}

/* ---------- Codex ---------- */

fn codex_remove(id: &str, dir: &Path) -> Result<Value, String> {
    if process_running("ChatGPT.exe") || process_running("codex.exe") {
        return Err("Codex 后台进程仍占用数据库，请完全退出客户端（含托盘与残留 codex.exe）后重试".to_string());
    }
    let home = codex::codex_home();
    let state_file = crate::sessions::latest_db(&home, "state_");
    let hist_file = crate::sessions::latest_db(&home, "thread_history_");
    let state_file = state_file.ok_or_else(|| "找不到 Codex 状态库".to_string())?;

    let mut dump = Map::new();
    dump.insert("platform".to_string(), Value::String("codex".to_string()));

    let state = open_rw(&state_file)?;
    dump.insert(
        "threads".to_string(),
        dump_table(&state, "threads", "id = ?", &[Value::String(id.to_string())])?,
    );
    for t in ["thread_dynamic_tools", "thread_read_receipts", "thread_attachments"] {
        if let Ok(d) = dump_table(&state, t, "thread_id = ?", &[Value::String(id.to_string())]) {
            dump.insert(t.to_string(), d);
        }
    }
    if let Ok(d) = dump_table(
        &state,
        "thread_spawn_edges",
        "parent_thread_id = ? or child_thread_id = ?",
        &[Value::String(id.to_string()), Value::String(id.to_string())],
    ) {
        dump.insert("edges".to_string(), d);
    }

    if let Some(hf) = &hist_file {
        let hist = open_rw(hf)?;
        if let Ok(d) = dump_table(&hist, "thread_items", "thread_id = ?", &[Value::String(id.to_string())]) {
            dump.insert("items".to_string(), d);
        }
    }

    let dump_value = Value::Object(dump);
    fs::write(dir.join("rows.json"), serde_json::to_string(&dump_value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    // 先备份再删；任何一步失败都回滚
    let result = (|| -> Result<(), String> {
        state.execute_batch("begin").map_err(|e| e.to_string())?;
        state
            .execute("delete from threads where id = ?1", [id])
            .map_err(|e| e.to_string())?;
        for t in ["thread_dynamic_tools", "thread_read_receipts", "thread_attachments"] {
            let _ = state.execute(&format!("delete from {t} where thread_id = ?1"), [id]);
        }
        let _ = state.execute(
            "delete from thread_spawn_edges where parent_thread_id = ?1 or child_thread_id = ?1",
            [id],
        );
        state.execute_batch("commit").map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = state.execute_batch("rollback");
        return Err(e);
    }

    if let Some(hf) = &hist_file {
        let hist = open_rw(hf)?;
        hist.execute("delete from thread_items where thread_id = ?1", [id])
            .map_err(|e| e.to_string())?;
    }

    // rollout 原始文件也一并进隔离区（如果还在）
    if let Some(row) = dump_value
        .get("threads")
        .and_then(|t| t.get("rows"))
        .and_then(Value::as_array)
        .and_then(|r| r.first())
        .and_then(Value::as_array)
        .cloned()
    {
        let cols = dump_value
            .get("threads")
            .and_then(|t| t.get("cols"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(idx) = cols.iter().position(|c| c.as_str() == Some("rollout_path")) {
            if let Some(rp) = row.get(idx).and_then(Value::as_str) {
                let rp = store::strip_verbatim_prefix(rp);
                let src = PathBuf::from(&rp);
                if !rp.is_empty() && src.exists() {
                    let dst = dir.join(crate::sessions::file_name_of(&src));
                    if fs::copy(&src, &dst).is_ok() {
                        let _ = fs::remove_file(&src);
                    }
                }
            }
        }
    }
    Ok(dump_value)
}

/* ---------- Cursor ---------- */

fn cursor_remove(id: &str, session: &Session, dir: &Path) -> Result<Value, String> {
    if process_running("Cursor.exe") {
        return Err("Cursor 正在运行并占用数据库，请完全退出 Cursor 后重试".to_string());
    }
    let file = if session.path.is_empty() { cursor::db_path() } else { PathBuf::from(&session.path) };
    if !file.exists() {
        return Err("找不到 Cursor 数据库".to_string());
    }

    let db = open_rw(&file)?;
    let like1 = format!("bubbleId:{id}:%");
    let like2 = format!("composerData:{id}");
    let dump = serde_json::json!({
        "platform": "cursor",
        "kv": dump_table(&db, "cursorDiskKV", "key like ? or key like ?", &[Value::String(like1.clone()), Value::String(like2.clone())])?,
        "headers": dump_table(&db, "composerHeaders", "composerId = ?", &[Value::String(id.to_string())])?,
    });
    fs::write(dir.join("rows.json"), serde_json::to_string(&dump).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        db.execute_batch("begin").map_err(|e| e.to_string())?;
        db.execute(
            "delete from cursorDiskKV where key like ?1 or key like ?2",
            rusqlite::params![like1, like2],
        )
        .map_err(|e| e.to_string())?;
        db.execute("delete from composerHeaders where composerId = ?1", [id])
            .map_err(|e| e.to_string())?;
        db.execute_batch("commit").map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = db.execute_batch("rollback");
        return Err(e);
    }
    Ok(dump)
}

/* ---------- 文件型平台 ---------- */

fn file_remove(session: &Session, dir: &Path) -> Result<(), String> {
    let src = PathBuf::from(&session.path);
    if session.path.is_empty() || !src.exists() {
        return Err("源文件不存在，可能已被外部删除".to_string());
    }
    let target = dir.join(crate::sessions::file_name_of(&src));
    store::copy_recursive(&src, &target).map_err(|e| e.to_string())?;
    if src.is_dir() {
        fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ---------- Hermes ---------- */

fn hermes_remove(id: &str, dir: &Path) -> Result<(), String> {
    let file = hermes::db_path();
    if !file.exists() {
        return Err("找不到 Hermes 数据库".to_string());
    }
    let db = open_rw(&file)?;
    let result = (|| -> Result<(), String> {
        db.execute_batch("begin immediate").map_err(|e| e.to_string())?;
        let sessions = dump_table(&db, "sessions", "id = ?", &[Value::String(id.to_string())])?;
        let messages = dump_table(&db, "messages", "session_id = ?", &[Value::String(id.to_string())])?;
        let empty = sessions
            .get("rows")
            .and_then(Value::as_array)
            .map(|r| r.is_empty())
            .unwrap_or(true);
        if empty {
            return Err("会话不存在，可能已被 Hermes 自己删除".to_string());
        }
        let body = serde_json::json!({"sessions": sessions, "messages": messages});
        fs::write(
            dir.join("rows.json"),
            serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        db.execute("delete from messages where session_id = ?1", [id])
            .map_err(|e| e.to_string())?;
        db.execute("delete from sessions where id = ?1", [id])
            .map_err(|e| e.to_string())?;
        db.execute_batch("commit").map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = db.execute_batch("rollback");
        // Hermes 给带网关运行记录的会话加了删除保护触发器，硬删会破坏它的运行账本
        if e.contains("Refused to delete") {
            return Err(
                "Hermes 不允许删除这个会话：它带有网关运行记录，删除会破坏 Hermes 的运行账本。可以改用归档。"
                    .to_string(),
            );
        }
        return Err(e);
    }
    Ok(())
}

/* ---------- 对外接口 ---------- */

fn is_file_platform(platform: &str) -> bool {
    matches!(platform, "claude" | "antigravity" | "vscode" | "kiro" | "pi" | "deepseek")
}

pub fn remove(platform: &str, id: &str, session: &Session) -> Result<TrashItem, String> {
    let dir = store::new_trash_dir(platform, id)?;

    if platform == "codex" {
        codex_remove(id, &dir)?;
    } else if platform == "cursor" {
        cursor_remove(id, session, &dir)?;
    } else if platform == "hermes" {
        hermes_remove(id, &dir)?;
    } else if is_file_platform(platform) {
        file_remove(session, &dir)?;
    } else {
        return Err(format!("平台 {platform} 暂不支持删除"));
    }

    let original_path = if session.path.is_empty() { None } else { Some(session.path.clone()) };
    let title = if session.title.is_empty() { id.to_string() } else { session.title.clone() };
    let manifest = serde_json::json!({
        "platform": platform,
        "id": id,
        "title": title,
        "originalPath": original_path,
        "deletedAt": store::now_ms(),
    });
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let kind = if matches!(platform, "codex" | "cursor" | "hermes") { "db" } else { "file" };
    let record = TrashItem {
        trash_id: crate::sessions::file_name_of(&dir),
        platform: platform.to_string(),
        id: id.to_string(),
        title,
        deleted_at: store::now_ms(),
        dir: dir.to_string_lossy().to_string(),
        kind: kind.to_string(),
        original_path,
        extra: Map::new(),
    };
    store::add_trash(record.clone())?;
    Ok(record)
}

/// 文件型平台靠路径还原；db 型平台把库路径写在 manifest 里
fn restore_original_path(item: &TrashItem) -> Result<PathBuf, String> {
    let manifest_file = Path::new(&item.dir).join("manifest.json");
    if let Ok(raw) = fs::read_to_string(&manifest_file) {
        if let Ok(m) = serde_json::from_str::<Value>(&raw) {
            if let Some(p) = m.get("originalPath").and_then(Value::as_str) {
                return Ok(PathBuf::from(p));
            }
        }
    }
    if let Some(p) = &item.original_path {
        return Ok(PathBuf::from(p));
    }
    Err("缺少原始路径信息，无法还原".to_string())
}

pub fn restore(trash_id: &str) -> Result<bool, String> {
    let item = store::list_trash()
        .into_iter()
        .find(|t| t.trash_id == trash_id)
        .ok_or_else(|| "隔离区里没有这一项".to_string())?;
    let dir = PathBuf::from(&item.dir);

    if item.kind == "file" {
        let entries: Vec<PathBuf> = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| crate::sessions::file_name_of(p) != "manifest.json")
            .collect();
        let copy = entries.first().ok_or_else(|| "隔离区里没有文件".to_string())?;
        let original = restore_original_path(&item)?;
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        store::copy_recursive(copy, &original).map_err(|e| e.to_string())?;
    } else {
        let raw = fs::read_to_string(dir.join("rows.json")).map_err(|e| e.to_string())?;
        let rows: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if item.platform == "codex" {
            let state_file = crate::sessions::latest_db(&codex::codex_home(), "state_")
                .ok_or_else(|| "找不到 Codex 状态库".to_string())?;
            let db = open_rw(&state_file)?;
            for key in [
                "threads",
                "thread_dynamic_tools",
                "thread_read_receipts",
                "thread_attachments",
                "edges",
            ] {
                if let Some(d) = rows.get(key) {
                    restore_table(&db, d)?;
                }
            }
            if let (Some(hf), Some(items)) = (
                crate::sessions::latest_db(&codex::codex_home(), "thread_history_"),
                rows.get("items"),
            ) {
                let hist = open_rw(&hf)?;
                restore_table(&hist, items)?;
            }
        } else if item.platform == "hermes" {
            let db = open_rw(&hermes::db_path())?;
            if let Some(d) = rows.get("sessions") {
                restore_table(&db, d)?;
            }
            if let Some(d) = rows.get("messages") {
                restore_table(&db, d)?;
            }
        } else if item.platform == "cursor" {
            let original = restore_original_path(&item)?;
            let db = open_rw(&original)?;
            if let Some(d) = rows.get("kv") {
                restore_table(&db, d)?;
            }
            if let Some(d) = rows.get("headers") {
                restore_table(&db, d)?;
            }
        } else {
            return Err(format!("平台 {} 暂不支持还原", item.platform));
        }
    }

    store::drop_trash_record(trash_id)?;
    store::remove_trash_dir(&item.dir);
    Ok(true)
}

pub fn purge(trash_id: &str) -> Result<bool, String> {
    let item = store::list_trash().into_iter().find(|t| t.trash_id == trash_id);
    match item {
        None => Ok(false),
        Some(it) => {
            store::remove_trash_dir(&it.dir);
            store::drop_trash_record(trash_id)?;
            Ok(true)
        }
    }
}
