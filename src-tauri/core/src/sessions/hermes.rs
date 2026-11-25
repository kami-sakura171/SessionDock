//! Hermes：%LOCALAPPDATA%\hermes\state.db
//! 时间戳是 Unix 秒（带小数），统一转毫秒。被占用时复制临时副本，Drop 自动清理。

use super::*;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    let home = std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| store::local_app_data().join("hermes"));
    home.join("state.db")
}

fn to_ms(v: Option<f64>) -> Option<i64> {
    match v {
        Some(n) if n.is_finite() && n > 0.0 => Some((n * 1000.0).round() as i64),
        _ => None,
    }
}

fn num(v: &rusqlite::types::Value) -> Option<f64> {
    match v {
        rusqlite::types::Value::Integer(i) => Some(*i as f64),
        rusqlite::types::Value::Real(f) => Some(*f),
        rusqlite::types::Value::Text(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

pub fn list() -> Result<Vec<Session>, String> {
    let file = db_path();
    let handle = match open_read_only(&file, true) {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    let mut stmt = handle
        .conn
        .prepare(
            "select id, title, cwd, model, message_count, started_at, last_activity_at \
               from sessions where coalesce(hidden, 0) = 0 order by last_activity_at desc",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<usize, String>(0)?,
                row.get::<usize, Option<String>>(1)?,
                row.get::<usize, Option<String>>(2)?,
                row.get::<usize, Option<i64>>(4)?,
                row.get::<usize, rusqlite::types::Value>(5).ok(),
                row.get::<usize, rusqlite::types::Value>(6).ok(),
            ))
        })
        .map_err(|e| e.to_string())?;

    for r in rows.flatten() {
        let (id, title, cwd, count, started, last) = r;
        let created = to_ms(started.as_ref().and_then(num));
        let updated = to_ms(last.as_ref().and_then(num)).or(created);
        out.push(Session {
            id,
            platform: "hermes".to_string(),
            title: title
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "(无标题)".to_string()),
            project: cwd.as_deref().and_then(basename),
            cwd,
            created_at: created,
            updated_at: updated,
            message_count: count.unwrap_or(0),
            // 归档状态交给本应用管理：直接写 Hermes 的库会与它自己的进程抢写
            archived: false,
            account: None,
            path: file.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

pub fn read(id: &str) -> Result<Vec<Message>, String> {
    let handle = match open_read_only(&db_path(), true) {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    let mut stmt = handle
        .conn
        .prepare(
            "select role, content, timestamp from messages \
             where session_id = ?1 and role in ('user','assistant') \
               and coalesce(active, 1) = 1 and coalesce(compacted, 0) = 0 order by timestamp",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], |row| {
            Ok((
                row.get::<usize, String>(0)?,
                row.get::<usize, Option<String>>(1)?,
                row.get::<usize, rusqlite::types::Value>(2).ok(),
            ))
        })
        .map_err(|e| e.to_string())?;

    for r in rows.flatten() {
        let (role, content, ts) = r;
        let text = content.unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        out.push(Message::new(
            if role == "user" { "user" } else { "assistant" },
            text.trim().to_string(),
            to_ms(ts.as_ref().and_then(num)),
        ));
    }
    Ok(out)
}
