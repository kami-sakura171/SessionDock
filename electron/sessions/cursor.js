const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const store = require("../store");

/** 标题缓存：避免每次刷新都去扫 2GB 表里的用户气泡 */
const cacheFile = () => path.join(store.root(), "cursor-titles.json");

function loadTitles() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveTitles(map) {
  try {
    fs.mkdirSync(store.root(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(map), "utf8");
  } catch {
    /* 缓存写不进去不影响功能 */
  }
}

const dbPath = () =>
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");

/**
 * Cursor 的库经常有 2GB+，绝不能靠「复制一份」来绕锁。
 * 只读打开失败时直接返回 null，由上层降级为「该平台暂不可读」。
 */
function open() {
  if (!DatabaseSync) return null;
  const file = dbPath();
  if (!fs.existsSync(file)) return null;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

function list() {
  const db = open();
  if (!db) return [];

  try {
    // 1) 会话头（313 条左右）
    let headers = [];
    try {
      headers = db
        .prepare(
          `select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value
             from composerHeaders
            where composerId not like 'empty%'`
        )
        .all();
    } catch {
      return [];
    }

  // 2) 气泡：一次扫完，按 composer 归组（用 key 解析，避免 5 万次解析大 JSON）
  const bubbleCount = new Map();
  const firstUser = new Map();
  try {
    const cached = loadTitles();
    const candidates = new Map(); // cid -> 前几个气泡键，用来找首条用户消息

    for (const row of db.prepare("select key from cursorDiskKV where key like 'bubbleId:%'").all()) {
      const parts = row.key.split(":");
      if (parts.length < 3) continue;
      const cid = parts[1];
      bubbleCount.set(cid, (bubbleCount.get(cid) || 0) + 1);
      if (!cached[cid]) {
        const list = candidates.get(cid) || [];
        if (list.length < 4) list.push(row.key);
        candidates.set(cid, list);
      }
    }

    // 关键：用等值查询走唯一索引。LIKE 前缀会退化成全表扫描，122 条会话就是 122 次扫库。
    const lookup = db.prepare("select value from cursorDiskKV where key = ?");
    for (const [cid, keys] of candidates) {
      for (const k of keys) {
        const row = lookup.get(k);
        const d = row ? parse(row.value) : null;
        const text = d && d.type === 1 && typeof d.text === "string" ? d.text.trim() : "";
        if (text) {
          cached[cid] = text.slice(0, 90).replace(/\s+/g, " ");
          break;
        }
      }
    }

    for (const [cid, text] of Object.entries(cached)) firstUser.set(cid, text);
    if (candidates.size > 0) saveTitles(cached);
  } catch {
    /* 老版本没有 cursorDiskKV，忽略 */
  }

  // 3) 项目名：workspaceStorage/<id>/workspace.json 里有 folder
  const projectCache = new Map();
  const projectOf = (workspaceId) => {
    if (!workspaceId) return null;
    if (projectCache.has(workspaceId)) return projectCache.get(workspaceId);
    const wsFile = path.join(
      process.env.APPDATA || "",
      "Cursor", "User", "workspaceStorage", workspaceId, "workspace.json"
    );
    let name = null;
    try {
      const j = JSON.parse(fs.readFileSync(wsFile, "utf8"));
      const p = j.folder || j.workspace || "";
      name = p ? p.replace(/^file:\/\/\/?/, "").split(/[\\/]/).filter(Boolean).pop() : null;
    } catch {
      name = null;
    }
    projectCache.set(workspaceId, name);
    return name;
  };

  return headers
    .map((h) => {
      const head = parse(h.value) || {};
      return {
        id: h.composerId,
        platform: "cursor",
        title: (head.name || firstUser.get(h.composerId) || "(未命名会话)").slice(0, 120),
        project: projectOf(h.workspaceId),
        cwd: null,
        createdAt: h.createdAt || null,
        updatedAt: h.lastUpdatedAt || null,
        messageCount: bubbleCount.get(h.composerId) || 0,
        archived: !!h.isArchived,
        account: null,
        path: dbPath(),
      };
    })
    .filter((s) => s.messageCount > 0 || s.title !== "(未命名会话)");
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function read(id) {
  const db = open();
  if (!db) return [];

  let rows = [];
  try {
    rows = db
      .prepare("select value from cursorDiskKV where key like ?")
      .all(`bubbleId:${id}:%`);
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  const out = [];
  for (const row of rows) {
    const d = parse(row.value);
    if (!d) continue;
    const text = typeof d.text === "string" ? d.text.trim() : "";
    if (!text) continue;
    out.push({
      role: d.type === 1 ? "user" : "assistant",
      text,
      createdAt: d.createdAt ? Date.parse(d.createdAt) || 0 : 0,
      timestamp: d.createdAt ? Date.parse(d.createdAt) || null : null,
    });
  }

  // Cursor 不保证键序，用气泡自带的时间戳排
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out.map(({ role, text, timestamp }) => ({ role, text, timestamp }));
}

module.exports = { list, read };
