const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Pi（pi coding agent）把会话存成 JSONL：
 *   ~/.pi/agent/sessions/<项目目录>/<时间戳>_<会话id>.jsonl
 * 每行一个事件：
 *   {"type":"session","id","timestamp","cwd"}
 *   {"type":"message","message":{"role","content":[{type:"text"|"thinking"|"toolCall", ...}]}}
 *   {"type":"session_info","name":"标题"}
 * 标题取最后一个 session_info.name，没有就用首条用户消息兜底。
 */
const store = require("../store");

/** 按文件 mtime 缓存解析结果：Pi 的会话文件最大 6.8MB，没变就不重读 */
const indexPath = () => path.join(store.root(), "pi-index.json");

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveIndex(index) {
  try {
    fs.mkdirSync(store.root(), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify(index), "utf8");
  } catch {
    /* 缓存失败不影响功能 */
  }
}

const piHome = () =>
  process.env.PI_HOME || path.join(os.homedir(), ".pi", "agent", "sessions");

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** content 是块数组，只取 text 块，thinking / toolCall 不展示 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function readLines(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 单行坏了跳过 */
    }
  }
  return out;
}

function list() {
  const files = walk(piHome());
  const rows = [];
  const index = loadIndex();
  let dirty = false;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    const cached = index[file];
    if (cached && cached.mtime === stat.mtimeMs) {
      rows.push({
        id: cached.id,
        platform: "pi",
        title: cached.title,
        project: cached.cwd ? path.basename(String(cached.cwd)) : path.basename(path.dirname(file)),
        cwd: cached.cwd,
        createdAt: cached.createdAt,
        updatedAt: stat.mtimeMs,
        messageCount: cached.count,
        archived: false,
        account: null,
        path: file,
      });
      continue;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // 只解析首行拿元信息，不整文件 JSON.parse（大文件里有上千行 toolCall 块）
    const nl = raw.indexOf("\n");
    let head;
    try {
      head = JSON.parse(nl > 0 ? raw.slice(0, nl) : raw);
    } catch {
      continue;
    }
    if (!head || head.type !== "session") continue;

    // 标题：取最后一个 session_info 的 name
    let title = "";
    const infoLines = raw.match(/^\{"type":"session_info".*$/gm);
    if (infoLines) {
      for (const line of infoLines) {
        try {
          const o = JSON.parse(line);
          if (typeof o.name === "string" && o.name.trim()) title = o.name.trim();
        } catch {
          /* ignore */
        }
      }
    }

    // 兜底：首条用户消息的开头
    if (!title) {
      const userLine = raw.match(/^\{"type":"message".*"role":"user".*$/m);
      if (userLine) {
        try {
          const o = JSON.parse(userLine[0]);
          const t = textOf(o.message.content).replace(/\s+/g, " ").trim();
          if (t) title = t.slice(0, 60);
        } catch {
          /* ignore */
        }
      }
    }

    const userCount = (raw.match(/"role":"user"/g) || []).length;
    const assistantCount = (raw.match(/"role":"assistant"/g) || []).length;

    const row = {
      id: head.id,
      platform: "pi",
      title: title || "(无标题)",
      project: head.cwd ? path.basename(String(head.cwd)) : path.basename(path.dirname(file)),
      cwd: head.cwd || null,
      createdAt: head.timestamp ? Date.parse(head.timestamp) : stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
      messageCount: userCount + assistantCount,
      archived: false,
      account: null,
      path: file,
    };
    rows.push(row);

    index[file] = {
      mtime: stat.mtimeMs,
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      createdAt: row.createdAt,
      count: row.messageCount,
    };
    dirty = true;
  }

  // 清掉已经不存在的文件
  const alive = new Set(files);
  for (const key of Object.keys(index)) {
    if (!alive.has(key)) {
      delete index[key];
      dirty = true;
    }
  }

  if (dirty) saveIndex(index);
  return rows;
}

function read(id) {
  const file = walk(piHome()).find((f) => path.basename(f).includes(id));
  if (!file) return [];

  const out = [];
  for (const l of readLines(file)) {
    if (!l || l.type !== "message" || !l.message) continue;
    const role = l.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(l.message.content).trim();
    if (!text) continue;
    out.push({
      role,
      text,
      timestamp: l.timestamp ? Date.parse(l.timestamp) : null,
    });
  }
  return out;
}

module.exports = { list, read };
