//! Kiro（VS Code 分支）：%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent
//! 该目录在部分版本里为空（会话存在云端），此时按「已检测到、无本地会话」处理，不伪造数据。

use super::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn agent_root() -> PathBuf {
    store::app_data_base()
        .join("Kiro")
        .join("User")
        .join("globalStorage")
        .join("kiro.kiroagent")
}

fn transcript_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 4 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let full = entry.path();
        if full.is_dir() {
            transcript_files(&full, out, depth + 1);
        } else {
            let name = file_name_of(&full);
            if name.ends_with(".jsonl") || name.ends_with(".json") {
                out.push(full);
            }
        }
    }
}

pub fn list() -> Result<Vec<Session>, String> {
    let root = agent_root();
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    transcript_files(&root, &mut files, 0);

    let mut out = Vec::new();
    for file in files {
        let raw = match read_text_lossy(&file) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut title = String::new();
        let mut count = 0i64;
        for line in raw.split('\n').filter(|l| !l.is_empty()) {
            let d: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let text = d
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| d.get("content").and_then(Value::as_str))
                .unwrap_or("");
            if text.is_empty() {
                continue;
            }
            count += 1;
            if title.is_empty() {
                title = text
                    .split('\n')
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .to_string();
            }
        }
        if count == 0 {
            continue;
        }
        let mtime = store::mtime_ms(&file).map(|v| v as i64);
        let id = file_stem_of(&file);
        out.push(Session {
            id,
            platform: "kiro".to_string(),
            title: take_chars(&(if title.is_empty() { "(未命名会话)".to_string() } else { title }), 120),
            project: None,
            cwd: None,
            created_at: mtime,
            updated_at: mtime,
            message_count: count,
            archived: false,
            account: None,
            path: file.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let root = agent_root();
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    transcript_files(&root, &mut files, 0);
    let file = match files.iter().find(|f| file_name_of(f).starts_with(id)) {
        Some(f) => f,
        None => return Ok(Vec::new()),
    };
    let raw = match read_text_lossy(file) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let d: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let text = d
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| d.get("content").and_then(Value::as_str))
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            continue;
        }
        let is_assistant = d.get("role").and_then(Value::as_str) == Some("assistant")
            || d.get("type").and_then(Value::as_str) == Some("assistant");
        out.push(Message::new(
            if is_assistant { "assistant" } else { "user" },
            text.to_string(),
            None,
        ));
    }
    Ok(out)
}
