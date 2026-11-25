//! Cursor：%APPDATA%\Cursor\User\globalStorage\state.vscdb
//! 库经常有 2GB+，绝不能靠「复制一份」绕锁：只读打开失败就按「该平台暂不可读」处理。

use super::*;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

const TITLES_CACHE: &str = "cursor-titles.json";

pub fn db_path() -> PathBuf {
    store::app_data_base()
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb")
}

fn parse(s: &str) -> Option<Value> {
    serde_json::from_str(s).ok()
}

pub fn list() -> Result<Vec<Session>, String> {
    let file = db_path();
    let handle = match open_read_only(&file, false) {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };
    let conn = &handle.conn;

    // 1) 会话头
    let mut headers: Vec<(String, Option<String>, Option<i64>, Option<i64>, bool, Value)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value \
                   from composerHeaders where composerId not like 'empty%'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let cid = row.get::<usize, String>(0)?;
                let ws = row.get::<usize, Option<String>>(1)?;
                let created = row.get::<usize, rusqlite::types::Value>(2).ok();
                let updated = row.get::<usize, rusqlite::types::Value>(3).ok();
                let archived = row.get::<usize, rusqlite::types::Value>(4).ok();
                let value = row.get::<usize, Option<String>>(6)?.unwrap_or_default();
                let to_json = |v: Option<rusqlite::types::Value>| -> Value {
                    match v {
                        Some(rusqlite::types::Value::Text(s)) => Value::String(s),
                        Some(rusqlite::types::Value::Integer(i)) => Value::from(i),
                        Some(rusqlite::types::Value::Real(f)) => Value::from(f),
                        _ => Value::Null,
                    }
                };
                let created_ms = normalize_ts_json(&to_json(created));
                let updated_ms = normalize_ts_json(&to_json(updated));
                let arch = match to_json(archived) {
                    Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                    Value::Bool(b) => b,
                    _ => false,
                };
                Ok((cid, ws, created_ms, updated_ms, arch, Value::String(value)))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            headers.push(r);
        }
    }

    // 2) 气泡：一次扫完按 composer 归组；标题走缓存，没缓存的只取前几个气泡找首条用户消息
    let mut bubble_count: HashMap<String, i64> = HashMap::new();
    let mut cached_titles = store::read_json_cache(TITLES_CACHE);
    if !cached_titles.is_object() {
        cached_titles = Value::Object(serde_json::Map::new());
    }
    let mut candidates: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("select key from cursorDiskKV where key like 'bubbleId:%'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<usize, String>(0))
            .map_err(|e| e.to_string())?;
        for key in rows.flatten() {
            let parts: Vec<&str> = key.split(':').collect();
            if parts.len() < 3 {
                continue;
            }
            let cid = parts[1].to_string();
            *bubble_count.entry(cid.clone()).or_insert(0) += 1;
            if cached_titles.get(&cid).and_then(Value::as_str).is_none() {
                let list = candidates.entry(cid).or_default();
                if list.len() < 4 {
                    list.push(key);
                }
            }
        }
    }

    if !candidates.is_empty() {
        // 用等值查询走唯一索引；LIKE 前缀会退化成全表扫描
        let mut lookup = conn
            .prepare("select value from cursorDiskKV where key = ?1")
            .map_err(|e| e.to_string())?;
        for (cid, keys) in &candidates {
            for k in keys {
                let value: Option<String> = lookup.query_row([k], |row| row.get(0)).ok();
                let d = value.as_deref().and_then(parse);
                if let Some(d) = d {
                    let is_user = d.get("type").and_then(Value::as_i64) == Some(1);
                    let text = d.get("text").and_then(Value::as_str).unwrap_or("").trim();
                    if is_user && !text.is_empty() {
                        let title = collapse_ws(&take_chars(text, 90));
                        cached_titles
                            .as_object_mut()
                            .map(|o| o.insert(cid.clone(), Value::String(title)));
                        break;
                    }
                }
            }
        }
        store::write_json_cache(TITLES_CACHE, &cached_titles);
    }

    // 3) 项目名：workspaceStorage/<id>/workspace.json 里有 folder
    let mut project_cache: HashMap<String, Option<String>> = HashMap::new();
    let mut out = Vec::new();
    for (cid, ws, created, updated, archived, value) in headers {
        let head = value.as_str().and_then(parse).unwrap_or(Value::Null);
        let mut title = head
            .get("name")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| {
                cached_titles
                    .get(&cid)
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "(未命名会话)".to_string());
        title = take_chars(&title, 120);
        let count = bubble_count.get(&cid).copied().unwrap_or(0);
        if count == 0 && title == "(未命名会话)" {
            continue;
        }
        let project = match ws {
            Some(ws_id) if !ws_id.is_empty() => project_cache
                .entry(ws_id.clone())
                .or_insert_with(|| project_of(&ws_id))
                .clone(),
            _ => None,
        };
        out.push(Session {
            id: cid,
            platform: "cursor".to_string(),
            title,
            project,
            cwd: None,
            created_at: created,
            updated_at: updated,
            message_count: count,
            archived,
            account: None,
            path: file.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

fn project_of(workspace_id: &str) -> Option<String> {
    let ws_file = store::app_data_base()
        .join("Cursor")
        .join("User")
        .join("workspaceStorage")
        .join(workspace_id)
        .join("workspace.json");
    let raw = read_text_lossy(&ws_file).ok()?;
    let j: Value = serde_json::from_str(&raw).ok()?;
    let p = j
        .get("folder")
        .and_then(Value::as_str)
        .or_else(|| j.get("workspace").and_then(Value::as_str))
        .unwrap_or("");
    if p.is_empty() {
        return None;
    }
    let stripped = p
        .strip_prefix("file:///")
        .or_else(|| p.strip_prefix("file://"))
        .unwrap_or(p);
    basename(stripped)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let handle = match open_read_only(&db_path(), false) {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };
    let mut rows: Vec<String> = Vec::new();
    {
        let mut stmt = handle
            .conn
            .prepare("select value from cursorDiskKV where key like ?1")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([format!("bubbleId:{id}:%")], |row| row.get::<usize, String>(0))
            .map_err(|e| e.to_string())?;
        for r in mapped.flatten() {
            rows.push(r);
        }
    }

    let mut out: Vec<(i64, Message)> = Vec::new();
    for raw in rows {
        let d = match parse(&raw) {
            Some(v) => v,
            None => continue,
        };
        let text = d.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let role = if d.get("type").and_then(Value::as_i64) == Some(1) {
            "user"
        } else {
            "assistant"
        };
        let ts = d
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(parse_date_ms);
        out.push((ts.unwrap_or(0), Message::new(role, text.to_string(), ts)));
    }

    // Cursor 不保证键序，用气泡自带的时间戳排
    out.sort_by_key(|(ts, _)| *ts);
    Ok(out.into_iter().map(|(_, m)| m).collect())
}
