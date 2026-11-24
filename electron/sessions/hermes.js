const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/**
 * Hermes（Nous Research 的本地智能体）把会话存在 LOCALAPPDATA/hermes/state.db：
 *   sessions(id, title, cwd, model, message_count, started_at, last_activity_at, archived, hidden)
 *   messages(session_id, role, content, timestamp, active, compacted)
 * 时间戳是 Unix 秒（带小数），统一转成毫秒给上层用。
 */
const hermesHome = () =>
  process.env.HERMES_HOME ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes");

const dbPath = () => path.join(hermesHome(), "state.db");

function openReadOnly(file) {
  if (!DatabaseSync || !fs.existsSync(file)) return null;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    // 被 Hermes 占用时复制一份只读副本，避免锁冲突
    try {
      const tmp = path.join(os.tmpdir(), `csm-hermes-${Date.now()}.db`);
      fs.copyFileSync(file, tmp);
      return new DatabaseSync(tmp, { readOnly: true });
    } catch {
      return null;
    }
  }
}

const toMs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
};

function list() {
  const db = openReadOnly(dbPath());
  if (!db) return [];

  let rows = [];
  try {
    rows = db
      .prepare(
        `select id, title, cwd, model, message_count, started_at, last_activity_at
           from sessions
          where coalesce(hidden, 0) = 0
          order by last_activity_at desc`
      )
      .all();
  } catch {
    return [];
  }

  return rows.map((r) => ({
    id: r.id,
    platform: "hermes",
    title: String(r.title || "").trim() || "(无标题)",
    project: r.cwd ? path.basename(String(r.cwd)) : null,
    cwd: r.cwd ? String(r.cwd) : null,
    model: r.model || null,
    createdAt: toMs(r.started_at),
    updatedAt: toMs(r.last_activity_at) || toMs(r.started_at),
    messageCount: Number(r.message_count) || 0,
    // 归档状态交给本应用管理：直接写 Hermes 的库会与它自己的进程抢写
    archived: false,
    account: null,
    path: dbPath(),
  }));
}

function read(id) {
  const db = openReadOnly(dbPath());
  if (!db) return [];

  let rows = [];
  try {
    rows = db
      .prepare(
        `select role, content, timestamp
           from messages
          where session_id = ?
            and role in ('user', 'assistant')
            and coalesce(active, 1) = 1
            and coalesce(compacted, 0) = 0
          order by timestamp`
      )
      .all(id);
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    const text = typeof r.content === "string" ? r.content : "";
    if (!text.trim()) continue;
    out.push({
      role: r.role === "user" ? "user" : "assistant",
      text: text.trim(),
      timestamp: toMs(r.timestamp),
    });
  }
  return out;
}

module.exports = { list, read };
