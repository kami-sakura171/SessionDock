const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../store");

let DatabaseSync = null;
try {
  // Electron 33 内置 Node 20，没有 node:sqlite；此时退化为「用子进程 node 读」不可行，
  // 所以这里做能力探测，缺失时由上层给出明确提示，而不是静默失败。
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const codexHome = () =>
  process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".codex");

const rolloutIndexPath = () => path.join(store.root(), "codex-rollout-index.json");

function loadRolloutIndex() {
  try {
    return JSON.parse(fs.readFileSync(rolloutIndexPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveRolloutIndex(idx) {
  try {
    fs.mkdirSync(store.root(), { recursive: true });
    fs.writeFileSync(rolloutIndexPath(), JSON.stringify(idx), "utf8");
  } catch {
    /* ignore */
  }
}

function collectRolloutFiles(home) {
  const out = [];
  for (const sub of ["sessions", "archived_sessions"]) {
    const stack = [path.join(home, sub)];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".jsonl")) out.push(full);
      }
    }
  }
  return out;
}

/** 统一把秒 / 毫秒 / ISO 字符串转成毫秒时间戳 */
function normalizeTs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 库文件名带版本号（state_5 / thread_history_1），取数字最大的那个 */
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

/**
 * 只读打开。若正被 Codex 占用（WAL 需要写 shm），退化为复制到临时目录再读，
 * 保证绝不触碰正在运行的程序。
 */
function openReadOnly(file) {
  if (!DatabaseSync) return null;
  try {
    return { db: new DatabaseSync(file, { readOnly: true }), tmpDir: null };
  } catch {
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-"));
      const tmp = path.join(tmpDir, "db.sqlite");
      fs.copyFileSync(file, tmp);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, tmp + suffix);
      }
      return { db: new DatabaseSync(tmp, { readOnly: true }), tmpDir };
    } catch {
      return null;
    }
  }
}

function closeDb(handle) {
  if (!handle) return;
  try {
    handle.db.close();
  } catch {
    /* ignore */
  }
  if (handle.tmpDir) {
    try {
      fs.rmSync(handle.tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Codex 库里 title 是首条用户消息原文（常带附件注入块），
 * name 才是智能体里显示的短标题。这里以 name 为准，title 兜底并清洗。
 */
function cleanTitle(raw) {
  if (!raw) return "";
  let t = String(raw).replace(/\s+/g, " ").trim();
  const mark = t.indexOf("## My request:");
  if (t.includes("# Files mentioned by the user:") && mark >= 0) {
    t = t.slice(mark + "## My request:".length).trim();
  }
  // 去掉 [文本](链接) 语法，避免标题里出现 plugin:// 之类的地址
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return t.slice(0, 120);
}

function list() {
  const home = codexHome();
  const stateFile = latestDb(home, "state_");
  const histFile = latestDb(home, "thread_history_");
  if (!stateFile) return [];

  const counts = new Map();
  if (histFile) {
    const hist = openReadOnly(histFile);
    if (hist) {
      try {
        const rows = hist.db
          .prepare(
            "select thread_id, count(*) as c from thread_items " +
              "where item_type in ('userMessage','agentMessage') group by thread_id"
          )
          .all();
        for (const r of rows) counts.set(r.thread_id, r.c);
      } catch {
        /* 老版本没有该表，忽略 */
      } finally {
        closeDb(hist);
      }
    }
  }

  const state = openReadOnly(stateFile);
  if (!state) return [];

  let rows = [];
  try {
    const cols = new Set(state.db.prepare("pragma table_info(threads)").all().map((c) => c.name));
    const sel = (col, alias) => (cols.has(col) ? `t.${col}${alias ? ` as ${alias}` : ""}` : `null as ${alias || col}`);
    const orderCol = cols.has("updated_at_ms") ? "t.updated_at_ms" : cols.has("updated_at") ? "t.updated_at" : "t.created_at";
    const hasProjects = !!state.db.prepare("select name from sqlite_master where type='table' and name='projects'").get();
    const joinSql = hasProjects && cols.has("project_id")
      ? "left join projects p on p.id = t.project_id"
      : "";
    const projCol = hasProjects && cols.has("project_id") ? "p.name as project" : "null as project";

    const whereParts = [];
    if (cols.has("thread_source")) whereParts.push("coalesce(t.thread_source, '') != 'guardian_review'");
    if (cols.has("source")) whereParts.push("coalesce(t.source, '') not like '{\"subagent\":%'");
    const whereSql = whereParts.length ? `where ${whereParts.join(" and ")}` : "";

    rows = state.db
      .prepare(
        `select t.id, ${sel("name")}, ${sel("title")}, ${sel("archived")},
                ${sel("created_at")}, ${sel("updated_at")},
                ${sel("created_at_ms")}, ${sel("updated_at_ms")},
                ${sel("creator_account_id")}, ${sel("cwd")}, ${sel("rollout_path")}, ${projCol}
           from threads t ${joinSql}
          ${whereSql}
          order by ${orderCol} desc`
      )
      .all();
  } catch {
    return [];
  } finally {
    closeDb(state);
  }

  // 按 rollout 文件的 mtime 缓存消息数与最后时间，保证列表消息数、时间与详情页完全同步
  const rIndex = loadRolloutIndex();
  let rDirty = false;
  let allRollouts = null;

  const resolveRollout = (r) => {
    if (r.rollout_path) {
      const rp = String(r.rollout_path).replace(/^\\\\\?\\/, "");
      if (fs.existsSync(rp)) return rp;
    }
    if (allRollouts === null) allRollouts = collectRolloutFiles(home);
    return allRollouts.find((f) => path.basename(f).includes(r.id)) || null;
  };

  const result = rows.map((r) => {
    const createdAt = normalizeTs(r.created_at_ms) || normalizeTs(r.created_at);
    let updatedAt = normalizeTs(r.updated_at_ms) || normalizeTs(r.updated_at) || createdAt;
    let messageCount = counts.get(r.id) || 0;

    const rp = resolveRollout(r);
    if (rp) {
      try {
        const st = fs.statSync(rp);
        let entry = rIndex[rp];
        if (!entry || entry.mtime !== st.mtimeMs) {
          const msgs = readFromRollout(rp);
          const lastTs = msgs.length ? msgs[msgs.length - 1].timestamp : null;
          entry = { mtime: st.mtimeMs, count: msgs.length, lastTs };
          rIndex[rp] = entry;
          rDirty = true;
        }
        if (entry.count > messageCount) messageCount = entry.count;
        if (entry.lastTs && (!updatedAt || entry.lastTs > updatedAt)) updatedAt = entry.lastTs;
      } catch {
        /* ignore */
      }
    }

    const cwd = r.cwd ? String(r.cwd).replace(/^\\\\\?\\/, "") : null;
    return {
      id: r.id,
      platform: "codex",
      title: cleanTitle(r.name) || cleanTitle(r.title) || "(无标题)",
      project: r.project || (cwd ? path.basename(cwd) || null : null),
      cwd,
      createdAt,
      updatedAt,
      messageCount,
      archived: !!r.archived,
      account: r.creator_account_id || null,
      path: stateFile,
    };
  });

  if (rDirty) saveRolloutIndex(rIndex);
  return result;
}

function readFromHistory(id) {
  const histFile = latestDb(codexHome(), "thread_history_");
  if (!histFile) return [];
  const hist = openReadOnly(histFile);
  if (!hist) return [];

  let rows = [];
  try {
    rows = hist.db
      .prepare(
        `select item_type, item_json, created_at_ms from thread_items
          where thread_id = ? and item_type in ('userMessage','agentMessage')
          order by created_at_ms`
      )
      .all(id);
  } catch {
    return [];
  } finally {
    closeDb(hist);
  }

  const out = [];
  for (const r of rows) {
    let d;
    try {
      d = JSON.parse(r.item_json);
    } catch {
      continue;
    }
    const text = r.item_type === "userMessage" ? userText(d) : (d.text || "");
    if (!text.trim()) continue;
    out.push({
      role: r.item_type === "userMessage" ? "user" : "assistant",
      text: text.trim(),
      timestamp: normalizeTs(r.created_at_ms),
    });
  }
  return out;
}

function findRolloutPath(id) {
  const home = codexHome();
  const stateFile = latestDb(home, "state_");
  if (stateFile) {
    const state = openReadOnly(stateFile);
    if (state) {
      try {
        const row = state.db.prepare("select rollout_path from threads where id = ?").get(id);
        if (row && row.rollout_path) {
          const rp = String(row.rollout_path).replace(/^\\\\\?\\/, "");
          if (fs.existsSync(rp)) return rp;
        }
      } catch {
        /* ignore */
      } finally {
        closeDb(state);
      }
    }
  }

  // 兜底：在 sessions / archived_sessions 目录按会话 id 查找 rollout-*.jsonl
  for (const sub of ["sessions", "archived_sessions"]) {
    const base = path.join(home, sub);
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".jsonl") && e.name.includes(id)) return full;
      }
    }
  }
  return null;
}

function cleanRolloutUserText(raw) {
  let s = String(raw || "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<codex_internal_context[\s\S]*?<\/codex_internal_context>/g, "")
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/g, "")
    .trim();
  if (!s) return "";
  return formatAttachedFiles(s);
}

function readFromRollout(rp) {
  let raw = "";
  try {
    raw = fs.readFileSync(rp, "utf8");
  } catch {
    return [];
  }

  const respMsgs = [];
  const evtMsgs = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = normalizeTs(d.timestamp);

    if (d.type === "response_item" && d.payload && d.payload.type === "message") {
      const role = d.payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = Array.isArray(d.payload.content) ? d.payload.content : [];
      const joined = parts
        .map((c) => {
          if (!c) return "";
          if (typeof c.text === "string") return c.text;
          if (c.type === "image" || c.type === "input_image") return "[图片]";
          return "";
        })
        .filter(Boolean)
        .join("\n");
      const text = role === "user" ? cleanRolloutUserText(joined) : joined.trim();
      if (text) respMsgs.push({ role, text, timestamp: ts });
    } else if (d.type === "event_msg" && d.payload) {
      if (d.payload.type === "user_message") {
        const text = cleanRolloutUserText(d.payload.message || d.payload.text || "");
        if (text) evtMsgs.push({ role: "user", text, timestamp: ts });
      } else if (d.payload.type === "agent_message") {
        const text = String(d.payload.message || d.payload.text || "").trim();
        if (text) evtMsgs.push({ role: "assistant", text, timestamp: ts });
      }
    }
  }

  return respMsgs.length > 0 ? respMsgs : evtMsgs;
}

function read(id) {
  const histMsgs = readFromHistory(id);
  const rp = findRolloutPath(id);
  if (rp) {
    const rolloutMsgs = readFromRollout(rp);
    if (rolloutMsgs.length > histMsgs.length) return rolloutMsgs;
  }
  return histMsgs;
}

function formatAttachedFiles(raw) {
  if (raw.includes("# Files mentioned by the user:") && raw.includes("## My request:")) {
    const idx = raw.indexOf("## My request:");
    const head = raw.slice(0, idx);
    const files = head
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).split(":")[0].trim())
      .filter(Boolean);
    const req = raw.slice(idx + "## My request:".length).trim();
    if (files.length) return files.map((f) => `📎 ${f}`).join("\n") + "\n\n" + req;
  }
  return raw;
}

/** Codex 把附件清单塞进正文，压成「📎 文件名 + 真正请求」 */
function userText(d) {
  const raw = (d.content || [])
    .map((c) => (c && c.type === "text" ? c.text : c && c.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");

  return formatAttachedFiles(raw);
}

module.exports = { list, read, available: () => !!DatabaseSync };
