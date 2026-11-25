//! Claude Code：~/.claude/projects 下深度 <= 2 的 .jsonl

use super::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn projects_root() -> PathBuf {
    // 测试可用 CLAUDE_PROJECTS_DIR 指到合成目录，避免读真实数据
    if let Some(p) = std::env::var_os("CLAUDE_PROJECTS_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    store::home_dir().join(".claude").join("projects")
}

fn walk(dir: &Path, out: &mut Vec<Session>, depth: usize) {
    if depth > 2 {
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
        } else if file_name_of(&full).ends_with(".jsonl") {
            if let Some(s) = summarize(&full) {
                out.push(s);
            }
        }
    }
}

pub fn list() -> Result<Vec<Session>, String> {
    let mut out = Vec::new();
    walk(&projects_root(), &mut out, 0);
    Ok(out)
}

/// 逐行扫一遍汇总元数据；单文件可能十几 MB，但只在刷新时执行
fn summarize(file: &Path) -> Option<Session> {
    let content = read_text_lossy(file).ok()?;
    let mut title = String::new();
    let mut cwd: Option<String> = None;
    let mut first_user = String::new();
    let mut count = 0i64;

    for line in content.split('\n') {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                for key in ["title", "aiTitle", "content"] {
                    if let Some(t) = v.get(key).and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            title = t.trim().to_string();
                            break;
                        }
                    }
                }
            }
            Some("user") => {
                count += 1;
                if cwd.is_none() {
                    cwd = v.get("cwd").and_then(Value::as_str).map(|s| s.to_string());
                }
                if first_user.is_empty() {
                    let t = extract_text(&v);
                    let t = t.trim();
                    if !t.is_empty() && !t.contains("<local-command-caveat>") {
                        first_user = take_chars(t, 80);
                    }
                }
            }
            Some("assistant") => count += 1,
            _ => {}
        }
    }

    if count == 0 {
        return None;
    }
    if title.is_empty() {
        title = if first_user.is_empty() { "(无标题)".to_string() } else { first_user };
    }
    let mtime = store::mtime_ms(file).map(|v| v as i64);
    Some(Session {
        id: file_stem_of(file),
        platform: "claude".to_string(),
        title,
        project: cwd.as_deref().and_then(basename),
        cwd,
        created_at: mtime,
        updated_at: mtime,
        message_count: count,
        archived: false,
        account: None,
        path: file.to_string_lossy().to_string(),
    })
}

fn find_file(dir: &Path, id: &str, depth: usize) -> Option<PathBuf> {
    if depth > 2 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let full = entry.path();
        if full.is_dir() {
            if let Some(hit) = find_file(&full, id, depth + 1) {
                return Some(hit);
            }
        } else if file_name_of(&full) == format!("{id}.jsonl") {
            return Some(full);
        }
    }
    None
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let file = match find_file(&projects_root(), id, 0) {
        Some(f) => f,
        None => return Ok(Vec::new()),
    };
    let content = match read_text_lossy(&file) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for line in content.split('\n') {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let role = match v.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let text = extract_text(&v);
        let text = text.trim();
        if text.is_empty() || text.starts_with("<local-command") {
            continue;
        }
        let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_date_ms);
        out.push(Message::new(role, text.to_string(), ts));
    }
    Ok(out)
}

/// content 可能是字符串，也可能是 block 数组（text / thinking / tool_use）
fn extract_text(v: &Value) -> String {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| v.get("content"));
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
