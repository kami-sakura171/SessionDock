//! VS Code：%APPDATA%\Code\User\workspaceStorage\*\chatSessions\*.json

use super::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn user_root() -> PathBuf {
    store::app_data_base().join("Code").join("User")
}

fn parse_file(file: &Path) -> Option<Value> {
    let raw = read_text_lossy(file).ok()?;
    serde_json::from_str(&raw).ok()
}

/// workspace.json 里的 folder 字段能给出项目名
fn project_of(workspace_dir: &Path) -> Option<String> {
    let j = parse_file(&workspace_dir.join("workspace.json"))?;
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

fn workspaces() -> Vec<PathBuf> {
    let root = user_root().join("workspaceStorage");
    match fs::read_dir(&root) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub fn list() -> Result<Vec<Session>, String> {
    let mut out = Vec::new();
    for ws_dir in workspaces() {
        let chat_dir = ws_dir.join("chatSessions");
        let entries = match fs::read_dir(&chat_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let project = project_of(&ws_dir);

        for entry in entries.flatten() {
            let file = entry.path();
            if !file_name_of(&file).ends_with(".json") {
                continue;
            }
            let d = match parse_file(&file) {
                Some(v) => v,
                None => continue,
            };
            let requests = match d.get("requests").and_then(Value::as_array) {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };
            let text = requests[0]
                .get("message")
                .and_then(|m| m.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let title = text
                .split('\n')
                .find(|l| !l.trim().is_empty())
                .map(|l| take_chars(l, 120))
                .unwrap_or_else(|| "(未命名会话)".to_string());
            let id = d
                .get("sessionId")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .unwrap_or_else(|| file_stem_of(&file));
            out.push(Session {
                id,
                platform: "vscode".to_string(),
                title,
                project: project.clone(),
                cwd: None,
                created_at: d.get("creationDate").and_then(normalize_ts_json),
                updated_at: d
                    .get("lastMessageDate")
                    .and_then(normalize_ts_json)
                    .or_else(|| d.get("creationDate").and_then(normalize_ts_json)),
                message_count: (requests.len() * 2) as i64,
                archived: false,
                account: None,
                path: file.to_string_lossy().to_string(),
            });
        }
    }
    Ok(out)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    for ws_dir in workspaces() {
        let file = ws_dir.join("chatSessions").join(format!("{id}.json"));
        let d = match parse_file(&file) {
            Some(v) => v,
            None => continue,
        };
        let requests = match d.get("requests").and_then(Value::as_array) {
            Some(r) => r,
            None => continue,
        };

        let mut out = Vec::new();
        for req in requests {
            let ts = req.get("timestamp").and_then(normalize_ts_json);
            let q = req
                .get("message")
                .and_then(|m| m.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !q.trim().is_empty() {
                out.push(Message::new("user", q.trim().to_string(), ts));
            }
            let parts = req.get("response").and_then(Value::as_array).cloned().unwrap_or_default();
            let a = parts
                .iter()
                .map(|p| {
                    p.get("value")
                        .and_then(Value::as_str)
                        .or_else(|| p.get("text").and_then(Value::as_str))
                        .unwrap_or("")
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let a = a.trim();
            if !a.is_empty() {
                out.push(Message::new("assistant", a.to_string(), ts));
            }
        }
        return Ok(out);
    }
    Ok(Vec::new())
}
