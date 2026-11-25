//! Codex：`~/.codex` 下的 state_*.sqlite / thread_history_*.sqlite + rollout-*.jsonl
//! 要点：
//!   - 过滤内部子代理（guardian_review / source 以 {"subagent": 开头）
//!   - 秒 / 毫秒 / ISO 时间戳统一转毫秒
//!   - 消息数与时间以 rollout 为准（谁多用谁），按 mtime 缓存避免每次全量解析
//!   - 只读打开失败时复制 sqlite + wal + shm 到临时目录，Drop 时清理

use super::*;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| store::home_dir().join(".codex"))
}

const ROLLOUT_INDEX: &str = "codex-rollout-index.json";

fn collect_rollout_files(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for sub in ["sessions", "archived_sessions"] {
        let mut stack = vec![home.join(sub)];
        while let Some(dir) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let full = entry.path();
                if entry.path().is_dir() {
                    stack.push(full);
                } else if file_name_of(&full).ends_with(".jsonl") {
                    out.push(full);
                }
            }
        }
    }
    out
}

/** 标题以 name 为准（title 常带附件注入块），兜底清洗 */
fn clean_title(raw: &str) -> String {
    static LINK_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\[([^\]]+)\]\([^)]*\)").expect("link regex"));
    if raw.is_empty() {
        return String::new();
    }
    let mut t = collapse_ws(raw);
    const MARK: &str = "## My request:";
    if t.contains("# Files mentioned by the user:") {
        if let Some(idx) = t.find(MARK) {
            t = t[idx + MARK.len()..].trim().to_string();
        }
    }
    // 去掉 [文本](链接) 语法，避免标题里出现 plugin:// 之类的地址
    t = LINK_RE.replace_all(&t, "$1").to_string();
    take_chars(&t, 120)
}

pub fn list() -> Result<Vec<Session>, String> {
    let home = codex_home();
    let state_file = latest_db(&home, "state_");
    let hist_file = latest_db(&home, "thread_history_");
    let state_file = match state_file {
        Some(f) => f,
        None => return Ok(Vec::new()),
    };

    let mut counts: HashMap<String, i64> = HashMap::new();
    if let Some(hf) = &hist_file {
        if let Some(hist) = open_read_only(hf, true) {
            if let Ok(mut stmt) = hist.conn.prepare(
                "select thread_id, count(*) as c from thread_items \
                 where item_type in ('userMessage','agentMessage') group by thread_id",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((row.get::<usize, String>(0)?, row.get::<usize, i64>(1)?))
                }) {
                    for r in rows.flatten() {
                        counts.insert(r.0, r.1);
                    }
                }
            }
        }
    }

    let state = match open_read_only(&state_file, true) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };

    let cols = table_columns(&state.conn, "threads").unwrap_or_default();
    let has = |c: &str| cols.contains(c);
    let sel = |col: &str| -> String {
        if has(col) {
            format!("t.{col} as {col}")
        } else {
            format!("null as {col}")
        }
    };
    let order_col = if has("updated_at_ms") {
        "t.updated_at_ms"
    } else if has("updated_at") {
        "t.updated_at"
    } else {
        "t.created_at"
    };
    let has_projects = table_exists(&state.conn, "projects") && has("project_id");
    let join_sql = if has_projects { "left join projects p on p.id = t.project_id" } else { "" };
    let proj_col = if has_projects { "p.name as project" } else { "null as project" };

    let mut where_parts: Vec<String> = Vec::new();
    if has("thread_source") {
        where_parts.push("coalesce(t.thread_source, '') != 'guardian_review'".to_string());
    }
    if has("source") {
        where_parts.push("coalesce(t.source, '') not like '{\"subagent\":%'".to_string());
    }
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!("where {}", where_parts.join(" and "))
    };

    let sql = format!(
        "select t.id, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {} \
           from threads t {} {} order by {} desc",
        sel("name"),
        sel("title"),
        sel("archived"),
        sel("created_at"),
        sel("updated_at"),
        sel("created_at_ms"),
        sel("updated_at_ms"),
        sel("creator_account_id"),
        sel("cwd"),
        sel("rollout_path"),
        proj_col,
        join_sql,
        where_sql,
        order_col
    );

    let mut rows: Vec<Vec<Value>> = Vec::new();
    {
        let mut stmt = state.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                let mut vals = Vec::with_capacity(12);
                for i in 0..12 {
                    let v = row.get::<usize, rusqlite::types::Value>(i)?;
                    vals.push(match &v {
                        rusqlite::types::Value::Text(s) => Value::String(s.clone()),
                        _ => db_value_to_json(ValueRef::from(&v)),
                    });
                }
                Ok(vals)
            })
            .map_err(|e| e.to_string())?;
        for r in mapped {
            rows.push(r.map_err(|e| e.to_string())?);
        }
    }
    drop(state);

    // 按 rollout 文件的 mtime 缓存消息数与最后时间，保证列表与详情页完全同步
    let mut r_index = store::read_json_cache(ROLLOUT_INDEX);
    if !r_index.is_object() {
        r_index = Value::Object(Map::new());
    }
    let mut dirty = false;
    let mut all_rollouts: Option<Vec<PathBuf>> = None;
    let mut result = Vec::new();

    for r in rows {
        let id = json_text(r.first());
        let created_at = normalize_ts_json(&r[6]).or_else(|| normalize_ts_json(&r[4]));
        let mut updated_at = normalize_ts_json(&r[7])
            .or_else(|| normalize_ts_json(&r[5]))
            .or(created_at);
        let mut message_count = counts.get(&id).copied().unwrap_or(0);

        // 先按库里的 rollout_path 找，找不到再按 id 扫 sessions / archived_sessions
        let mut rp = r[10]
            .as_str()
            .map(store::strip_verbatim_prefix)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.exists());
        if rp.is_none() {
            let files = all_rollouts.get_or_insert_with(|| collect_rollout_files(&home));
            rp = files
                .iter()
                .find(|f| file_name_of(f).contains(&id))
                .cloned();
        }

        if let Some(path) = rp {
            if let Some(m) = store::mtime_ms(&path) {
                let key = path.to_string_lossy().to_string();
                let cached = r_index.get(&key).cloned();
                let fresh = cached
                    .as_ref()
                    .and_then(|e| e.get("mtime"))
                    .and_then(Value::as_f64)
                    .map(|mm| store::same_mtime(mm, m))
                    .unwrap_or(false);
                let entry = if fresh {
                    cached.clone().unwrap()
                } else {
                    let msgs = read_from_rollout(&path);
                    let last_ts = msgs.last().and_then(|m| m.timestamp);
                    let e = serde_json::json!({"mtime": m, "count": msgs.len(), "lastTs": last_ts});
                    r_index
                        .as_object_mut()
                        .map(|o| o.insert(key.clone(), e.clone()));
                    dirty = true;
                    e
                };
                let cnt = entry.get("count").and_then(Value::as_i64).unwrap_or(0);
                if cnt > message_count {
                    message_count = cnt;
                }
                if let Some(ts) = entry.get("lastTs").and_then(normalize_ts_json) {
                    if updated_at.map(|u| ts > u).unwrap_or(true) {
                        updated_at = Some(ts);
                    }
                }
            }
        }

        let cwd = r[9].as_str().map(store::strip_verbatim_prefix).filter(|s| !s.is_empty());
        let project = json_text(r.get(11))
            .into_option()
            .or_else(|| cwd.as_deref().and_then(basename));
        let title = {
            let by_name = clean_title(&json_text(r.get(1)));
            if !by_name.is_empty() {
                by_name
            } else {
                let by_title = clean_title(&json_text(r.get(2)));
                if by_title.is_empty() { "(无标题)".to_string() } else { by_title }
            }
        };

        result.push(Session {
            id,
            platform: "codex".to_string(),
            title,
            project,
            cwd,
            created_at,
            updated_at,
            message_count,
            archived: r[3].as_bool().unwrap_or_else(|| r[3].as_i64().unwrap_or(0) != 0),
            account: json_text(r.get(8)).into_option(),
            path: state_file.to_string_lossy().to_string(),
        });
    }

    if dirty {
        store::write_json_cache(ROLLOUT_INDEX, &r_index);
    }
    Ok(result)
}

trait IntoOption {
    fn into_option(self) -> Option<String>;
}
impl IntoOption for String {
    fn into_option(self) -> Option<String> {
        if self.is_empty() { None } else { Some(self) }
    }
}

fn read_from_history(id: &str) -> Vec<Message> {
    let hist_file = match latest_db(&codex_home(), "thread_history_") {
        Some(f) => f,
        None => return Vec::new(),
    };
    let hist = match open_read_only(&hist_file, true) {
        Some(h) => h,
        None => return Vec::new(),
    };

    let mut rows: Vec<(String, String, Option<i64>)> = Vec::new();
    if let Ok(mut stmt) = hist.conn.prepare(
        "select item_type, item_json, created_at_ms from thread_items \
         where thread_id = ?1 and item_type in ('userMessage','agentMessage') order by created_at_ms",
    ) {
        if let Ok(mapped) = stmt.query_map([id], |row| {
            let ty = row.get::<usize, String>(0)?;
            let body = row.get::<usize, String>(1)?;
            let ts = row.get::<usize, rusqlite::types::Value>(2)?;
            let ts = match &ts {
                rusqlite::types::Value::Text(s) => normalize_ts_str(s),
                rusqlite::types::Value::Integer(i) => normalize_ts_str(&i.to_string()),
                rusqlite::types::Value::Real(f) => normalize_ts_str(&f.to_string()),
                _ => None,
            };
            Ok((ty, body, ts))
        }) {
            for r in mapped.flatten() {
                rows.push(r);
            }
        }
    }

    let mut out = Vec::new();
    for (ty, body, ts) in rows {
        let d: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let text = if ty == "userMessage" {
            user_text(&d)
        } else {
            json_text(d.get("text"))
        };
        if text.trim().is_empty() {
            continue;
        }
        out.push(Message::new(
            if ty == "userMessage" { "user" } else { "assistant" },
            text.trim().to_string(),
            ts,
        ));
    }
    out
}

fn find_rollout_path(id: &str) -> Option<PathBuf> {
    let home = codex_home();
    if let Some(state_file) = latest_db(&home, "state_") {
        if let Some(state) = open_read_only(&state_file, true) {
            let rp: Option<String> = state
                .conn
                .query_row("select rollout_path from threads where id = ?1", [id], |row| {
                    row.get::<usize, Option<String>>(0)
                })
                .ok()
                .flatten();
            if let Some(rp) = rp {
                let p = PathBuf::from(store::strip_verbatim_prefix(&rp));
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    for f in collect_rollout_files(&home) {
        if file_name_of(&f).contains(id) {
            return Some(f);
        }
    }
    None
}

fn clean_rollout_user_text(raw: &str) -> String {
    static RULES: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
        [
            r"<environment_context>[\s\S]*?</environment_context>",
            r"<codex_internal_context[\s\S]*?</codex_internal_context>",
            r"<user_instructions>[\s\S]*?</user_instructions>",
            r"<permissions instructions>[\s\S]*?</permissions instructions>",
            r"<collaboration_mode>[\s\S]*?</collaboration_mode>",
        ]
        .iter()
        .map(|p| regex::Regex::new(p).expect("codex clean regex"))
        .collect()
    });
    let mut s = raw.to_string();
    for re in RULES.iter() {
        s = re.replace_all(&s, "").to_string();
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        return String::new();
    }
    format_attached_files(&s)
}

pub fn read_from_rollout(rp: &Path) -> Vec<Message> {
    let raw = match read_text_lossy(rp) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut resp = Vec::new();
    let mut evt = Vec::new();

    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let d: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = normalize_ts_json(d.get("timestamp").unwrap_or(&Value::Null));
        let ty = d.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = d.get("payload").cloned().unwrap_or(Value::Null);

        if ty == "response_item" && payload.get("type").and_then(Value::as_str) == Some("message") {
            let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let parts = payload.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
            let joined = parts
                .iter()
                .map(|c| {
                    if let Some(t) = c.get("text").and_then(Value::as_str) {
                        return t.to_string();
                    }
                    match c.get("type").and_then(Value::as_str) {
                        Some("image") | Some("input_image") => "[图片]".to_string(),
                        _ => String::new(),
                    }
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let text = if role == "user" {
                clean_rollout_user_text(&joined)
            } else {
                joined.trim().to_string()
            };
            if !text.is_empty() {
                resp.push(Message::new(role, text, ts));
            }
        } else if ty == "event_msg" {
            let pty = payload.get("type").and_then(Value::as_str).unwrap_or("");
            let raw_text = payload
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| payload.get("text").and_then(Value::as_str))
                .unwrap_or("");
            if pty == "user_message" {
                let text = clean_rollout_user_text(raw_text);
                if !text.is_empty() {
                    evt.push(Message::new("user", text, ts));
                }
            } else if pty == "agent_message" {
                let text = raw_text.trim().to_string();
                if !text.is_empty() {
                    evt.push(Message::new("assistant", text, ts));
                }
            }
        }
    }

    if resp.is_empty() { evt } else { resp }
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let hist = read_from_history(id);
    if let Some(rp) = find_rollout_path(id) {
        let rollout = read_from_rollout(&rp);
        if rollout.len() > hist.len() {
            return Ok(rollout);
        }
    }
    Ok(hist)
}

/** Codex 把附件清单塞进正文，压成「📎 文件名 + 真正请求」 */
fn format_attached_files(raw: &str) -> String {
    const HEAD: &str = "# Files mentioned by the user:";
    const MARK: &str = "## My request:";
    if raw.contains(HEAD) && raw.contains(MARK) {
        let idx = raw.find(MARK).unwrap_or(0);
        let head = &raw[..idx];
        let files: Vec<String> = head
            .split('\n')
            .filter(|l| l.starts_with("## "))
            .map(|l| {
                l[3..]
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        let req = raw[idx + MARK.len()..].trim();
        if !files.is_empty() {
            let list = files
                .iter()
                .map(|f| format!("📎 {f}"))
                .collect::<Vec<_>>()
                .join("\n");
            return format!("{list}\n\n{req}");
        }
    }
    raw.to_string()
}

fn user_text(d: &Value) -> String {
    let parts = d.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let raw = parts
        .iter()
        .map(|c| match c.get("type").and_then(Value::as_str) {
            Some("text") => json_text(c.get("text")),
            Some("image") => "[图片]".to_string(),
            _ => String::new(),
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    format_attached_files(&raw)
}
