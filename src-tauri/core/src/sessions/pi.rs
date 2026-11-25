//! Pi（pi coding agent）：~/.pi/agent/sessions/<项目目录>/<时间戳>_<会话id>.jsonl
//! 按文件 mtime 缓存解析结果：会话文件最大几 MB，没变就不重读。

use super::*;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const INDEX_CACHE: &str = "pi-index.json";

fn pi_home() -> PathBuf {
    std::env::var_os("PI_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| store::home_dir().join(".pi").join("agent").join("sessions"))
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let full = entry.path();
        if full.is_dir() {
            walk(&full, out);
        } else if file_name_of(&full).ends_with(".jsonl") {
            out.push(full);
        }
    }
}

/// content 是块数组，只取 text 块，thinking / toolCall 不展示
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn list() -> Result<Vec<Session>, String> {
    let mut files = Vec::new();
    walk(&pi_home(), &mut files);
    let mut index = store::read_json_cache(INDEX_CACHE);
    if !index.is_object() {
        index = Value::Object(Map::new());
    }
    let mut dirty = false;
    let mut rows = Vec::new();

    for file in &files {
        let key = file.to_string_lossy().to_string();
        let mtime = match store::mtime_ms(file) {
            Some(m) => m,
            None => continue,
        };
        let cached = index.get(&key).cloned();
        let fresh = cached
            .as_ref()
            .and_then(|c| c.get("mtime"))
            .and_then(Value::as_f64)
            .map(|m| store::same_mtime(m, mtime))
            .unwrap_or(false);

        if fresh {
            let c = cached.clone().unwrap();
            let cwd = c.get("cwd").and_then(Value::as_str).map(|s| s.to_string());
            let project = cwd
                .as_deref()
                .and_then(basename)
                .or_else(|| file.parent().map(|p| file_name_of(p)));
            rows.push(Session {
                id: json_text(c.get("id")),
                platform: "pi".to_string(),
                title: json_text(c.get("title")),
                project,
                cwd,
                created_at: c.get("createdAt").and_then(normalize_ts_json),
                updated_at: Some(mtime as i64),
                message_count: c.get("count").and_then(Value::as_i64).unwrap_or(0),
                archived: false,
                account: None,
                path: key,
            });
            continue;
        }

        let raw = match read_text_lossy(file) {
            Ok(r) => r,
            Err(_) => continue,
        };

        // 只解析首行拿元信息，不整文件 JSON.parse（大文件里有上千行 toolCall 块）
        let head_line = raw.split('\n').next().unwrap_or("");
        let head: Value = match serde_json::from_str(head_line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if head.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }

        // 标题：取最后一个 session_info 的 name
        static INFO_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r#"(?m)^\{"type":"session_info".*$"#).expect("pi info regex")
        });
        static USER_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r#"(?m)^\{"type":"message".*"role":"user".*$"#).expect("pi user regex")
        });

        let mut title = String::new();
        for m in INFO_RE.find_iter(&raw) {
            if let Ok(o) = serde_json::from_str::<Value>(m.as_str()) {
                if let Some(name) = o.get("name").and_then(Value::as_str) {
                    if !name.trim().is_empty() {
                        title = name.trim().to_string();
                    }
                }
            }
        }

        // 兜底：首条用户消息的开头
        if title.is_empty() {
            if let Some(m) = USER_RE.find(&raw) {
                if let Ok(o) = serde_json::from_str::<Value>(m.as_str()) {
                    let t = text_of(o.get("message").and_then(|mm| mm.get("content")));
                    let t = collapse_ws(&t);
                    if !t.is_empty() {
                        title = take_chars(&t, 60);
                    }
                }
            }
        }

        let user_count = raw.match_indices("\"role\":\"user\"").count() as i64;
        let assistant_count = raw.match_indices("\"role\":\"assistant\"").count() as i64;
        let cwd = head.get("cwd").and_then(Value::as_str).map(|s| s.to_string());
        let created_at = head
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_date_ms)
            .or_else(|| store::birthtime_ms(file).map(|v| v as i64));
        let id = json_text(head.get("id"));
        let project = cwd
            .as_deref()
            .and_then(basename)
            .or_else(|| file.parent().map(|p| file_name_of(p)));
        let title = if title.is_empty() { "(无标题)".to_string() } else { title };

        rows.push(Session {
            id: id.clone(),
            platform: "pi".to_string(),
            title: title.clone(),
            project,
            cwd: cwd.clone(),
            created_at,
            updated_at: Some(mtime as i64),
            message_count: user_count + assistant_count,
            archived: false,
            account: None,
            path: key.clone(),
        });

        index.as_object_mut().map(|o| {
            o.insert(
                key,
                serde_json::json!({
                    "mtime": mtime,
                    "id": id,
                    "title": title,
                    "cwd": cwd,
                    "createdAt": created_at,
                    "count": user_count + assistant_count,
                }),
            )
        });
        dirty = true;
    }

    // 清掉已经不存在的文件
    let alive: std::collections::HashSet<String> =
        files.iter().map(|f| f.to_string_lossy().to_string()).collect();
    let stale: Vec<String> = index
        .as_object()
        .map(|o| o.keys().filter(|k| !alive.contains(*k)).cloned().collect())
        .unwrap_or_default();
    for k in stale {
        index.as_object_mut().map(|o| o.remove(&k));
        dirty = true;
    }

    if dirty {
        store::write_json_cache(INDEX_CACHE, &index);
    }
    Ok(rows)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let mut files = Vec::new();
    walk(&pi_home(), &mut files);
    let file = match files.iter().find(|f| file_name_of(f).contains(id)) {
        Some(f) => f,
        None => return Ok(Vec::new()),
    };
    let raw = match read_text_lossy(file) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for line in raw.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let l: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if l.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let msg = match l.get("message") {
            Some(m) => m,
            None => continue,
        };
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = text_of(msg.get("content"));
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let ts = l.get("timestamp").and_then(Value::as_str).and_then(parse_date_ms);
        out.push(Message::new(role, text.to_string(), ts));
    }
    Ok(out)
}
