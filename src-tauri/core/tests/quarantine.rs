//! 隔离区闭环回归测试：全部使用临时目录与合成数据，不触碰真实平台数据。
//! 运行：cargo test -- --test-threads=1（环境变量是进程级的，必须串行）

use session_dock_core::sessions::{self, Session};
use session_dock_core::{delete, store};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct TempEnv {
    root: PathBuf,
    _guard: MutexGuard<'static, ()>,
}

impl TempEnv {
    fn new(tag: &str) -> Self {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("sessiondock-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let data = root.join("appdata");
        fs::create_dir_all(&data).unwrap();
        std::env::set_var("SESSIONDOCK_DATA_DIR", &data);
        Self { root, _guard: guard }
    }
}

impl Drop for TempEnv {
    fn drop(&mut self) {
        std::env::remove_var("SESSIONDOCK_DATA_DIR");
        std::env::remove_var("CODEX_HOME");
        std::env::remove_var("CLAUDE_PROJECTS_DIR");
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn session(platform: &str, id: &str, path: &PathBuf) -> Session {
    Session {
        id: id.to_string(),
        platform: platform.to_string(),
        title: "测试会话".to_string(),
        path: path.to_string_lossy().to_string(),
        ..Default::default()
    }
}

#[test]
fn archive_flags_roundtrip() {
    let _env = TempEnv::new("archive");
    assert!(!store::is_archived("claude", "a"));
    store::set_archived("claude", "a", true).unwrap();
    assert!(store::is_archived("claude", "a"));
    store::set_archived_many(&[("pi".to_string(), "b".to_string()), ("pi".to_string(), "c".to_string())], true).unwrap();
    assert!(store::is_archived("pi", "b") && store::is_archived("pi", "c"));
    store::set_archived("claude", "a", false).unwrap();
    assert!(!store::is_archived("claude", "a"));
    assert!(store::is_archived("pi", "b"));
}

#[test]
fn file_platform_quarantine_roundtrip() {
    let env = TempEnv::new("file");
    let projects = env.root.join("projects");
    fs::create_dir_all(&projects).unwrap();
    let file = projects.join("test-abc.jsonl");
    let body = concat!(
        "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"content\":\"你好\"}}\n",
        "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"回复\"}]}}\n"
    );
    fs::write(&file, body).unwrap();

    let s = session("claude", "test-abc", &file);
    let record = delete::remove("claude", "test-abc", &s).expect("文件型平台删除应成功");
    assert!(!file.exists(), "原文件应被移走");
    assert_eq!(store::list_trash().len(), 1);
    assert!(PathBuf::from(&record.dir).join("test-abc.jsonl").exists());

    delete::restore(&record.trash_id).expect("还原应成功");
    assert!(file.exists(), "还原后原文件应回来");
    assert_eq!(fs::read_to_string(&file).unwrap(), body);
    assert!(store::list_trash().is_empty(), "还原后隔离区应为空");

    // 再删一次，这次彻底删除
    let record2 = delete::remove("claude", "test-abc", &s).unwrap();
    let dir2 = record2.dir.clone();
    delete::purge(&record2.trash_id).unwrap();
    assert!(!PathBuf::from(&dir2).exists(), "彻底删除后备份目录应消失");
    assert!(store::list_trash().is_empty());
}

fn sqlite(path: &PathBuf, sql: &str) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(sql).unwrap();
}

#[test]
fn codex_db_quarantine_roundtrip() {
    let env = TempEnv::new("codex");
    let home = env.root.join("codex-home");
    fs::create_dir_all(&home).unwrap();
    std::env::set_var("CODEX_HOME", &home);

    sqlite(
        &home.join("state_1.sqlite"),
        "create table threads (id text primary key, name text, title text, archived integer,
            created_at_ms integer, updated_at_ms integer, cwd text, rollout_path text,
            thread_source text, source text);
         insert into threads values ('t1', '测试标题', '原始标题', 0, 1700000000000, 1700000001000,
            'E:\\\\proj', null, 'cli', null);
         insert into threads values ('g1', 'Guardian review', 'x', 0, 1, 1, null, null,
            'guardian_review', null);
         insert into threads values ('s1', '子代理', 'x', 0, 1, 1, null, null, null,
            '{\"subagent\":\"x\"}');",
    );
    sqlite(
        &home.join("thread_history_1.sqlite"),
        "create table thread_items (thread_id text, item_type text, item_json text, created_at_ms integer);
         insert into thread_items values ('t1', 'userMessage',
            '{\"content\":[{\"type\":\"text\",\"text\":\"问题一\"}]}', 1700000000000);
         insert into thread_items values ('t1', 'agentMessage', '{\"text\":\"回答一\"}', 1700000000500);
         insert into thread_items values ('t1', 'toolCall', '{}', 1700000000600);",
    );

    let list = sessions::codex::list().expect("扫描合成 Codex 库");
    assert_eq!(list.len(), 1, "guardian_review 与 subagent 必须被过滤，实际: {list:?}");
    assert_eq!(list[0].id, "t1");
    assert_eq!(list[0].title, "测试标题");
    assert_eq!(list[0].message_count, 2, "只统计 user/agent 消息");
    assert_eq!(list[0].updated_at, Some(1700000001000));
    assert_eq!(list[0].project.as_deref(), Some("proj"));

    let msgs = sessions::codex::read("t1").unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].text, "问题一");
    assert_eq!(msgs[1].text, "回答一");

    let s = session("codex", "t1", &home.join("state_1.sqlite"));
    let record = match delete::remove("codex", "t1", &s) {
        Ok(r) => r,
        Err(e) if e.contains("占用") => {
            eprintln!("跳过：本机 Codex 进程正在运行（{e}），进程占用保护已生效");
            return;
        }
        Err(e) => panic!("删除失败: {e}"),
    };
    assert!(sessions::codex::list().unwrap().is_empty(), "删除后应扫不到该会话");
    assert!(PathBuf::from(&record.dir).join("rows.json").exists());

    delete::restore(&record.trash_id).expect("数据库还原应成功");
    let after = sessions::codex::list().unwrap();
    assert_eq!(after.len(), 1, "还原后应能重新扫到");
    let msgs_after = sessions::codex::read("t1").unwrap();
    assert_eq!(msgs_after.len(), 2);
    assert_eq!(msgs_after[0].text, "问题一");
    assert_eq!(msgs_after[1].text, "回答一");

    // 清空隔离区应返回体积统计
    let s2 = session("codex", "t1", &home.join("state_1.sqlite"));
    delete::remove("codex", "t1", &s2).unwrap();
    let (count, bytes) = store::clear_trash().unwrap();
    assert_eq!(count, 1);
    assert!(bytes > 0);
    assert!(store::list_trash().is_empty());
}

#[test]
fn export_markdown_format() {
    let env = TempEnv::new("export");
    let projects = env.root.join("projects");
    fs::create_dir_all(&projects).unwrap();
    std::env::set_var("CLAUDE_PROJECTS_DIR", &projects);
    fs::write(
        projects.join("md-test.jsonl"),
        "{\"type\":\"user\",\"message\":{\"content\":\"  你好  \"}}\n{\"type\":\"assistant\",\"message\":{\"content\":\" world \"}}\n",
    )
    .unwrap();
    let md = sessions::export_markdown("claude", "md-test", "标题").unwrap();
    assert!(md.starts_with("# 标题\n\n- 平台: Claude Code\n- 会话 ID: `md-test`\n\n---\n\n"));
    assert!(md.contains("### 👤 用户\n\n你好\n\n"));
    assert!(md.contains("### 🤖 助手\n\nworld\n\n"));
}
