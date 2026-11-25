//! Antigravity：~/.gemini/antigravity/brain/<id>/transcript/*.jsonl

use super::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn brain_root() -> PathBuf {
    store::home_dir().join(".gemini").join("antigravity").join("brain")
}

/// 递归收集某个 brain 目录下所有 transcript 分片，按文件名排序（00000000、00000001…）
fn chunks_of(brain_dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        if depth > 6 {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let full = entry.path();
            if full.is_dir() {
                walk(&full, out, depth + 1);
            } else {
                let name = file_name_of(&full);
                // 对齐原版：路径里任意一级叫 transcript 都算（含 transcript 下的嵌套目录）
                let in_transcript = full
                    .ancestors()
                    .any(|a| file_name_of(a) == "transcript");
                if name.ends_with(".jsonl") && in_transcript {
                    out.push(full);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(brain_dir, &mut out, 0);
    out.sort();
    out
}

fn strip_tags(s: &str) -> String {
    static USER_REQUEST: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"<USER_REQUEST>([\s\S]*?)</USER_REQUEST>").expect("ur regex")
    });
    static META: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>").expect("meta regex")
    });
    static SYS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"<SYSTEM_MESSAGE>[\s\S]*?</SYSTEM_MESSAGE>").expect("sys regex")
    });
    let s = USER_REQUEST.replace_all(s, "$1").to_string();
    let s = META.replace_all(&s, "").to_string();
    let s = SYS.replace_all(&s, "").to_string();
    s.trim().to_string()
}

fn parse_brain(brain_dir: &Path) -> (Vec<Message>, String, Option<i64>) {
    let mut messages = Vec::new();
    let mut title = String::new();
    let mut updated_at: Option<i64> = None;

    for file in chunks_of(brain_dir) {
        let raw = match read_text_lossy(&file) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for line in raw.split('\n') {
            if line.is_empty() {
                continue;
            }
            let d: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let when = d.get("created_at").and_then(Value::as_str).and_then(parse_date_ms);
            if let Some(w) = when {
                updated_at = Some(updated_at.map(|u| u.max(w)).unwrap_or(w));
            }

            let ty = d.get("type").and_then(Value::as_str).unwrap_or("");
            if ty != "USER_INPUT" && ty != "PLANNER_RESPONSE" {
                continue;
            }
            let text = strip_tags(d.get("content").and_then(Value::as_str).unwrap_or(""));
            if text.is_empty() {
                continue; // 工具调用没有正文，跳过
            }
            if ty == "USER_INPUT" {
                if title.is_empty() {
                    title = text
                        .split('\n')
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                        .to_string();
                }
                messages.push(Message::new("user", text, when));
            } else {
                messages.push(Message::new("assistant", text, when));
            }
        }
    }

    let title = if title.is_empty() { "(未命名会话)".to_string() } else { title };
    (messages, take_chars(&title, 120), updated_at)
}

pub fn list() -> Result<Vec<Session>, String> {
    let root = brain_root();
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let (messages, title, updated_at) = parse_brain(&dir);
        if messages.is_empty() {
            continue;
        }
        out.push(Session {
            id: file_name_of(&dir),
            platform: "antigravity".to_string(),
            title,
            project: None,
            cwd: None,
            created_at: updated_at,
            updated_at,
            message_count: messages.len() as i64,
            archived: false,
            account: None,
            path: dir.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let dir = brain_root().join(id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    Ok(parse_brain(&dir).0)
}
