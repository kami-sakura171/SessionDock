//! DeepSeek Harness（~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd）适配器。
//! 注意：session.v4.jsonl.zstd 由多个拼接的 zstd frame 组成，需要循环解完所有 frame。

use super::{basename, normalize_ts_json, Message, Session};
use crate::store;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

static SYS_REMINDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").expect("regex"));

fn file_mtime_ms(path: &Path) -> Option<i64> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn dsh_sessions_root() -> PathBuf {
    if let Some(p) = std::env::var_os("DSH_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p).join("sessions");
        }
    }
    store::home_dir().join(".dsh").join("sessions")
}

fn index_path() -> PathBuf {
    store::root().join("dsh-index.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CachedSession {
    mtime: i64,
    id: String,
    title: String,
    project: Option<String>,
    cwd: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    message_count: i64,
}

fn load_index() -> HashMap<String, CachedSession> {
    fs::read_to_string(index_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_index(index: &HashMap<String, CachedSession>) {
    let _ = fs::create_dir_all(store::root());
    if let Ok(s) = serde_json::to_string(index) {
        let _ = fs::write(index_path(), s);
    }
}

fn collect_session_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(workspaces) = fs::read_dir(root) else {
        return out;
    };
    for ws in workspaces.flatten() {
        let ws_path = ws.path();
        if !ws_path.is_dir() {
            continue;
        }
        let Ok(sessions) = fs::read_dir(&ws_path) else {
            continue;
        };
        for sess in sessions.flatten() {
            let sess_dir = sess.path();
            if !sess_dir.is_dir() {
                continue;
            }
            let zstd_file = sess_dir.join("session.v4.jsonl.zstd");
            if zstd_file.is_file() {
                out.push(zstd_file);
                continue;
            }
            let plain_file = sess_dir.join("session.v4.jsonl");
            if plain_file.is_file() {
                out.push(plain_file);
            }
        }
    }
    out
}

/// 解压拼接的多个 zstd frame（或读取纯文本 jsonl）
fn read_decompressed(file: &Path) -> Result<String, String> {
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    let is_zstd = file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zstd"));
    if !is_zstd {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }

    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let mut cursor = Cursor::new(&bytes[pos..]);
        let mut dec = match zstd::stream::read::Decoder::new(&mut cursor) {
            Ok(d) => d,
            Err(_) => break,
        };
        let mut chunk = Vec::new();
        if dec.read_to_end(&mut chunk).is_err() {
            break;
        }
        out.extend_from_slice(&chunk);
        drop(dec);
        let consumed = cursor.position() as usize;
        if consumed == 0 {
            break;
        }
        pos += consumed;
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn extract_text(content: Option<&Value>) -> String {
    let Some(c) = content else {
        return String::new();
    };
    if let Some(s) = c.as_str() {
        return s.to_string();
    }
    let Some(arr) = c.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter_map(|b| {
            let obj = b.as_object()?;
            let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "text" || kind.is_empty() {
                obj.get("text").and_then(Value::as_str).map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn clean_user_text(raw: &str) -> String {
    SYS_REMINDER_RE.replace_all(raw, "").trim().to_string()
}

struct ParsedDsh {
    id: String,
    title: String,
    cwd: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    messages: Vec<Message>,
}

fn parse_file(file: &Path) -> Option<ParsedDsh> {
    let raw = read_decompressed(file).ok()?;
    let fallback_id = file
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .strip_prefix("session-")
        .or_else(|| {
            file.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
        })
        .unwrap_or("")
        .to_string();

    let mut id = String::new();
    let mut cwd: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut updated_at: Option<i64> = None;
    let mut title = String::new();
    let mut first_user = String::new();
    let mut messages = Vec::new();

    let reader = BufReader::new(raw.as_bytes());
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(d) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let kind = d.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "session" => {
                if id.is_empty() {
                    if let Some(sid) = d.get("id").and_then(Value::as_str) {
                        id = sid.to_string();
                    }
                }
                if cwd.is_none() {
                    cwd = d
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty());
                }
                if created_at.is_none() {
                    created_at = d.get("createdAt").and_then(normalize_ts_json);
                }
            }
            "session/title" => {
                if let Some(t) = d
                    .get("data")
                    .and_then(|x| x.get("title"))
                    .and_then(Value::as_str)
                {
                    let t = t.trim();
                    if !t.is_empty() {
                        title = t.to_string();
                    }
                }
            }
            "user/message" => {
                let ts = d.get("time").and_then(normalize_ts_json);
                if let Some(t) = ts {
                    updated_at = Some(updated_at.map_or(t, |cur| cur.max(t)));
                }
                let raw_txt = extract_text(d.get("data").and_then(|x| x.get("content")));
                let text = clean_user_text(&raw_txt);
                if text.is_empty() {
                    continue;
                }
                if first_user.is_empty() {
                    first_user = text
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                }
                messages.push(Message::new("user", text, ts));
            }
            "assistant/message" => {
                let ts = d.get("time").and_then(normalize_ts_json);
                if let Some(t) = ts {
                    updated_at = Some(updated_at.map_or(t, |cur| cur.max(t)));
                }
                let content = d
                    .get("data")
                    .and_then(|x| x.get("message").and_then(|m| m.get("content")).or_else(|| x.get("content")));
                let text = extract_text(content).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                messages.push(Message::new("assistant", text, ts));
            }
            _ => {}
        }
    }

    if id.is_empty() {
        id = fallback_id;
    }
    if id.is_empty() || messages.is_empty() {
        return None;
    }

    let final_title = if !title.is_empty() {
        title
    } else if !first_user.is_empty() {
        first_user
    } else {
        "(未命名会话)".to_string()
    };

    Some(ParsedDsh {
        id,
        title: truncate_chars(&final_title, 120),
        cwd,
        created_at,
        updated_at: updated_at.or(created_at),
        messages,
    })
}

pub fn list() -> Result<Vec<Session>, String> {
    let root = dsh_sessions_root();
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let files = collect_session_files(&root);
    let mut index = load_index();
    let mut dirty = false;
    let mut rows = Vec::new();
    let mut alive = HashSet::new();

    for file in &files {
        let Some(mtime) = file_mtime_ms(file) else {
            continue;
        };
        let key = file.to_string_lossy().to_string();
        alive.insert(key.clone());

        let sess_dir = file
            .parent()
            .unwrap_or(file)
            .to_string_lossy()
            .to_string();

        if let Some(c) = index.get(&key) {
            if c.mtime == mtime {
                if c.message_count > 0 {
                    rows.push(Session {
                        id: c.id.clone(),
                        platform: "deepseek".to_string(),
                        title: c.title.clone(),
                        project: c.project.clone(),
                        cwd: c.cwd.clone(),
                        created_at: c.created_at,
                        updated_at: c.updated_at.or(Some(mtime)),
                        message_count: c.message_count,
                        archived: false,
                        account: None,
                        path: sess_dir,
                    });
                }
                continue;
            }
        }

        if let Some(parsed) = parse_file(file) {
            let project = parsed.cwd.as_deref().and_then(basename);
            let msg_count = parsed.messages.len() as i64;
            let upd = parsed.updated_at.or(Some(mtime));
            let row = Session {
                id: parsed.id.clone(),
                platform: "deepseek".to_string(),
                title: parsed.title.clone(),
                project: project.clone(),
                cwd: parsed.cwd.clone(),
                created_at: parsed.created_at,
                updated_at: upd,
                message_count: msg_count,
                archived: false,
                account: None,
                path: sess_dir,
            };
            index.insert(
                key,
                CachedSession {
                    mtime,
                    id: parsed.id,
                    title: parsed.title,
                    project,
                    cwd: parsed.cwd,
                    created_at: parsed.created_at,
                    updated_at: upd,
                    message_count: msg_count,
                },
            );
            rows.push(row);
            dirty = true;
        }
    }

    let before = index.len();
    index.retain(|k, _| alive.contains(k));
    if index.len() != before {
        dirty = true;
    }
    if dirty {
        save_index(&index);
    }

    Ok(rows)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let root = dsh_sessions_root();
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let files = collect_session_files(&root);
    let hit = files.into_iter().find(|f| {
        f.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == id || n == format!("session-{id}") || n.contains(id))
    });
    let Some(file) = hit else {
        return Ok(Vec::new());
    };
    Ok(parse_file(&file).map(|p| p.messages).unwrap_or_default())
}
