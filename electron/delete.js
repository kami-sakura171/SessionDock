const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const store = require("./store");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/* ---------- 工具 ---------- */

const sha256 = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

/** 平台进程在跑就不动它的库，避免写入被覆盖或把库写坏 */
function processRunning(image) {
  try {
    const out = execFileSync("tasklist.exe", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return out.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

/** 把 Buffer / Uint8Array 序列化成 base64，便于 dump 到 JSON */
const encodeRow = (row) =>
  row.map((v) => {
    if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString("base64") };
    return v;
  });

const decodeRow = (row) =>
  row.map((v) => (v && typeof v === "object" && v.__b64 ? Buffer.from(v.__b64, "base64") : v));

function dumpTable(db, table, where, params = []) {
  const cols = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
  const rows = db.prepare(`select * from ${table} where ${where}`).all(...params);
  return { table, cols, rows: rows.map((r) => encodeRow(cols.map((c) => r[c]))) };
}

function restoreTable(db, dump) {
  const sql = `insert or replace into ${dump.table} (${dump.cols.join(",")}) values (${dump.cols
    .map(() => "?")
    .join(",")})`;
  const stmt = db.prepare(sql);
  for (const row of dump.rows) stmt.run(...decodeRow(row));
}

/* ---------- 各平台的删除/还原 ---------- */

const CODEX_HOME = () => process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".codex");

function latestDb(dir, prefix) {
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) continue;
    const version = Number(name.slice(prefix.length, -".sqlite".length)) || 0;
    if (!best || version > best.version) best = { version, file: path.join(dir, name) };
  }
  return best ? best.file : null;
}

function codexRemove(id, session, dir) {
  if (processRunning("ChatGPT.exe") || processRunning("codex.exe")) {
    throw new Error("Codex 后台进程仍占用数据库，请完全退出客户端（含托盘与残留 codex.exe）后重试");
  }
  const home = CODEX_HOME();
  const stateFile = latestDb(home, "state_");
  const histFile = latestDb(home, "thread_history_");
  if (!stateFile) throw new Error("找不到 Codex 状态库");

  const dump = { platform: "codex" };
  const state = new DatabaseSync(stateFile);
  try {
    dump.threads = dumpTable(state, "threads", "id = ?", [id]);
    for (const t of ["thread_dynamic_tools", "thread_read_receipts", "thread_attachments"]) {
      try {
        dump[t] = dumpTable(state, t, "thread_id = ?", [id]);
      } catch {
        /* 表可能不存在 */
      }
    }
    try {
      dump.edges = dumpTable(state, "thread_spawn_edges", "parent_thread_id = ? or child_thread_id = ?", [id, id]);
    } catch {
      /* ignore */
    }
  } finally {
    state.close();
  }

  if (histFile) {
    const hist = new DatabaseSync(histFile);
    try {
      dump.items = dumpTable(hist, "thread_items", "thread_id = ?", [id]);
    } finally {
      hist.close();
    }
  }

  fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(dump), "utf8");

  const state2 = new DatabaseSync(stateFile);
  try {
    state2.exec("begin");
    state2.prepare("delete from threads where id = ?").run(id);
    for (const t of ["thread_dynamic_tools", "thread_read_receipts", "thread_attachments"]) {
      try {
        state2.prepare(`delete from ${t} where thread_id = ?`).run(id);
      } catch {
        /* ignore */
      }
    }
    try {
      state2.prepare("delete from thread_spawn_edges where parent_thread_id = ? or child_thread_id = ?").run(id, id);
    } catch {
      /* ignore */
    }
    state2.exec("commit");
  } catch (e) {
    try {
      state2.exec("rollback");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    state2.close();
  }

  if (histFile) {
    const hist2 = new DatabaseSync(histFile);
    try {
      hist2.prepare("delete from thread_items where thread_id = ?").run(id);
    } finally {
      hist2.close();
    }
  }

  // rollout 原始文件也一并进隔离区（如果还在）
  try {
    const row = dump.threads && dump.threads.rows && dump.threads.rows[0];
    const idx = dump.threads ? dump.threads.cols.indexOf("rollout_path") : -1;
    if (row && idx >= 0) {
      const rp = String(row[idx] || "").replace(/^\\\\\?\\/, "");
      if (rp && fs.existsSync(rp)) {
        fs.cpSync(rp, path.join(dir, path.basename(rp)));
        fs.rmSync(rp, { force: true });
      }
    }
  } catch {
    /* rollout 缺失不影响主流程 */
  }
  return dump;
}

function cursorRemove(id, session, dir) {
  if (processRunning("Cursor.exe")) {
    throw new Error("Cursor 正在运行并占用数据库，请完全退出 Cursor 后重试");
  }
  const file = session && session.path ? session.path : null;
  if (!file || !fs.existsSync(file)) throw new Error("找不到 Cursor 数据库");

  const db = new DatabaseSync(file);
  try {
    const dump = {
      platform: "cursor",
      kv: dumpTable(db, "cursorDiskKV", "key like ? or key like ?", [`bubbleId:${id}:%`, `composerData:${id}`]),
      headers: dumpTable(db, "composerHeaders", "composerId = ?", [id]),
    };
    fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(dump), "utf8");

    db.exec("begin");
    db.prepare("delete from cursorDiskKV where key like ? or key like ?").run(`bubbleId:${id}:%`, `composerData:${id}`);
    db.prepare("delete from composerHeaders where composerId = ?").run(id);
    db.exec("commit");
    return dump;
  } catch (e) {
    try {
      db.exec("rollback");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    db.close();
  }
}

/** 文件型平台：整个文件/目录进隔离区 */
function fileRemove(session, dir, isDir) {
  const src = session && session.path;
  if (!src || !fs.existsSync(src)) throw new Error("源文件不存在，可能已被外部删除");
  const target = path.join(dir, path.basename(src));
  fs.cpSync(src, target, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
  return { copiedTo: target, sha256: isDir ? null : sha256(target) };
}

/** Hermes 的会话存在本地 SQLite 里，删除/还原都按行备份 */
const HERMES_DB = () =>
  path.join(
    process.env.HERMES_HOME ||
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes"),
    "state.db"
  );

function hermesRemove(id, session, dir) {
  const file = HERMES_DB();
  if (!fs.existsSync(file)) throw new Error("找不到 Hermes 数据库");
  const db = new DatabaseSync(file);
  try {
    db.exec("begin immediate");
    const sessions = dumpTable(db, "sessions", "id = ?", [id]);
    const messages = dumpTable(db, "messages", "session_id = ?", [id]);
    if (!sessions.rows.length) throw new Error("会话不存在，可能已被 Hermes 自己删除");
    fs.writeFileSync(
      path.join(dir, "rows.json"),
      JSON.stringify({ sessions, messages }, null, 2),
      "utf8"
    );
    db.prepare("delete from messages where session_id = ?").run(id);
    db.prepare("delete from sessions where id = ?").run(id);
    db.exec("commit");
    return { rows: messages.rows.length, copiedTo: path.join(dir, "rows.json") };
  } catch (e) {
    try {
      db.exec("rollback");
    } catch {
      /* ignore */
    }
    // Hermes 给带网关运行记录的会话加了删除保护触发器，硬删会破坏它的运行账本
    if (String(e.message || "").includes("Refused to delete")) {
      throw new Error(
        "Hermes 不允许删除这个会话：它带有网关运行记录，删除会破坏 Hermes 的运行账本。可以改用归档。"
      );
    }
    throw e;
  } finally {
    db.close();
  }
}

/* ---------- 对外接口 ---------- */

const FILE_PLATFORMS = { claude: false, antigravity: true, vscode: false, kiro: false, pi: false };

function remove(platform, id, session) {
  const dir = store.newTrashDir(platform, id);
  let detail;

  if (platform === "codex") detail = codexRemove(id, session, dir);
  else if (platform === "cursor") detail = cursorRemove(id, session, dir);
  else if (platform === "hermes") detail = hermesRemove(id, session, dir);
  else if (platform in FILE_PLATFORMS) detail = fileRemove(session, dir, FILE_PLATFORMS[platform]);
  else throw new Error(`平台 ${platform} 暂不支持删除`);

  const originalPath = session && session.path ? session.path : null;
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ platform, id, title: session ? session.title : id, originalPath, deletedAt: Date.now() }, null, 2),
    "utf8"
  );

  const record = {
    trashId: path.basename(dir),
    platform,
    id,
    title: session ? session.title : id,
    deletedAt: Date.now(),
    dir,
    originalPath,
    kind: ["codex", "cursor", "hermes"].includes(platform) ? "db" : "file",
  };
  store.addTrash(record);
  return record;
}

function restore(trashId) {
  const item = store.listTrash().find((t) => t.trashId === trashId);
  if (!item) throw new Error("隔离区里没有这一项");

  if (item.kind === "file") {
    const entries = fs.readdirSync(item.dir).filter((f) => f !== "manifest.json");
    if (!entries.length) throw new Error("隔离区里没有文件");
    const copy = path.join(item.dir, entries[0]);
    const original = restoreOriginalPath(item);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.cpSync(copy, original, { recursive: true });
  } else {
    const rows = JSON.parse(fs.readFileSync(path.join(item.dir, "rows.json"), "utf8"));
    if (item.platform === "codex") {
      const stateFile = latestDb(CODEX_HOME(), "state_");
      const db = new DatabaseSync(stateFile);
      try {
        for (const key of ["threads", "thread_dynamic_tools", "thread_read_receipts", "thread_attachments", "edges"]) {
          if (rows[key]) restoreTable(db, rows[key]);
        }
      } finally {
        db.close();
      }
      const histFile = latestDb(CODEX_HOME(), "thread_history_");
      if (histFile && rows.items) {
        const hist = new DatabaseSync(histFile);
        try {
          restoreTable(hist, rows.items);
        } finally {
          hist.close();
        }
      }
    } else if (item.platform === "hermes") {
      const db = new DatabaseSync(HERMES_DB());
      try {
        if (rows.sessions) restoreTable(db, rows.sessions);
        if (rows.messages) restoreTable(db, rows.messages);
      } finally {
        db.close();
      }
    } else if (item.platform === "cursor") {
      const db = new DatabaseSync(restoreOriginalPath(item));
      try {
        if (rows.kv) restoreTable(db, rows.kv);
        if (rows.headers) restoreTable(db, rows.headers);
      } finally {
        db.close();
      }
    }
  }

  store.dropTrashRecord(trashId);
  store.removeTrashDir(item.dir);
  return true;
}

/** 文件型平台靠路径还原；db 型平台把库路径写在 manifest 里 */
function restoreOriginalPath(item) {
  const manifestFile = path.join(item.dir, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    return m.originalPath;
  }
  if (item.originalPath) return item.originalPath;
  throw new Error("缺少原始路径信息，无法还原");
}

function purge(trashId) {
  const item = store.listTrash().find((t) => t.trashId === trashId);
  if (!item) return false;
  store.removeTrashDir(item.dir);
  store.dropTrashRecord(trashId);
  return true;
}

module.exports = { remove, restore, purge };
