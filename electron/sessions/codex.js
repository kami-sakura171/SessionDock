const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
    return { db: new DatabaseSync(file, { readOnly: true }), copied: false };
  } catch {
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-"));
      const tmp = path.join(tmpDir, "db.sqlite");
      fs.copyFileSync(file, tmp);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, tmp + suffix);
      }
      return { db: new DatabaseSync(tmp, { readOnly: true }), copied: true };
    } catch {
      return null;
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
      }
    }
  }

  const state = openReadOnly(stateFile);
  if (!state) return [];

  let rows = [];
  try {
    rows = state.db
      .prepare(
        `select t.id, t.name, t.title, t.archived, t.created_at_ms, t.updated_at_ms,
                t.creator_account_id, t.cwd, p.name as project
           from threads t left join projects p on p.id = t.project_id
          order by t.updated_at_ms desc`
      )
      .all();
  } catch {
    return [];
  }

  return rows.map((r) => ({
    id: r.id,
    platform: "codex",
    title: cleanTitle(r.name) || cleanTitle(r.title) || "(无标题)",
    project: r.project || null,
    cwd: r.cwd ? String(r.cwd).replace(/^\\\\\?\\/, "") : null,
    createdAt: r.created_at_ms || null,
    updatedAt: r.updated_at_ms || null,
    messageCount: counts.get(r.id) || 0,
    archived: !!r.archived,
    account: r.creator_account_id || null,
    path: stateFile,
  }));
}

function read(id) {
  const home = codexHome();

  // 若存在 rollout 文件，优先读取完整历史（新版 Codex / 长对话通常写入 rollout.jsonl）
  const stateFile = latestDb(home, "state_");
  if (stateFile) {
    const state = openReadOnly(stateFile);
    if (state) {
      try {
        const row = state.db.prepare("select rollout_path from threads where id = ?").get(id);
        if (row && row.rollout_path) {
          const rolloutMsgs = readFromRollout(row.rollout_path);
          if (rolloutMsgs.length > 0) return rolloutMsgs;
        }
      } catch {
        /* ignore */
      }
    }
  }

  const histFile = latestDb(home, "thread_history_");
  if (!histFile) return [];
  const hist = openReadOnly(histFile);
  if (!hist) return [];

  const rows = hist.db
    .prepare(
      `select item_type, item_json, created_at_ms from thread_items
        where thread_id = ? and item_type in ('userMessage','agentMessage')
        order by created_at_ms`
    )
    .all(id);

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
      timestamp: r.created_at_ms || null,
    });
  }
  return out;
}

/** 从 Codex rollout JSONL 日志中解析完整消息流 */
function readFromRollout(file) {
  if (!file) return [];
  const p = String(file).replace(/^\\\\\?\\/, "");
  if (!fs.existsSync(p)) return [];
  let content = "";
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.includes('"response_item"') || !line.includes('"message"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj && obj.payload;
    if (!obj || obj.type !== "response_item" || !payload || payload.type !== "message") continue;
    const isUser = payload.role === "user";
    const text = isUser
      ? userText(payload)
      : (payload.content || [])
          .map((c) => (c && (c.text || c.input_text) ? (c.text || c.input_text) : ""))
          .filter(Boolean)
          .join("\n");
    if (!text.trim()) continue;
    // 过滤内部系统注入块（客户端时区、运行环境上下文、插件更新通知等）
    if (!isUser && /^<(?:codex_apps_client_time_context|environment_context|skills_instructions|tools)\b/.test(text.trim())) {
      continue;
    }
    out.push({
      role: isUser ? "user" : "assistant",
      text: text.trim(),
      timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : null,
    });
  }
  return out;
}

/** Codex 把附件清单塞进正文，压成「📎 文件名 + 真正请求」 */
function userText(d) {
  const raw = (d.content || [])
    .map((c) => (c && (c.type === "text" || c.type === "input_text") ? (c.text || "") : c && c.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");

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

module.exports = { list, read, available: () => !!DatabaseSync };
