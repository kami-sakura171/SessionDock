const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectsRoot = () =>
  path.join(process.env.USERPROFILE || os.homedir(), ".claude", "projects");

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

function list() {
  const root = projectsRoot();
  const out = [];
  walk(root, out, 0);
  return out;
}

function walk(dir, out, depth) {
  if (depth > 2) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.name.endsWith(".jsonl")) {
      const s = summarize(full);
      if (s) out.push(s);
    }
  }
}

/** 逐行扫一遍汇总元数据；单文件可能十几 MB，但只在刷新时执行。 */
function summarize(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let title = "";
  let cwd = null;
  let firstUser = "";
  let count = 0;

  for (const line of content.split("\n")) {
    if (!line) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v.type === "ai-title") {
      for (const key of ["title", "aiTitle", "content"]) {
        if (typeof v[key] === "string" && v[key].trim()) {
          title = v[key].trim();
          break;
        }
      }
    } else if (v.type === "user") {
      count++;
      if (!cwd && v.cwd) cwd = v.cwd;
      if (!firstUser) {
        const t = extractText(v).trim();
        if (t && !t.includes("<local-command-caveat>")) firstUser = t.slice(0, 80);
      }
    } else if (v.type === "assistant") {
      count++;
    }
  }

  if (count === 0) return null;
  if (!title) title = firstUser || "(无标题)";

  return {
    id: path.basename(file, ".jsonl"),
    platform: "claude",
    title,
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || null : null,
    cwd,
    createdAt: mtime(file),
    updatedAt: mtime(file),
    messageCount: count,
    archived: false,
    account: null,
    path: file,
  };
}

function read(id) {
  const file = findFile(projectsRoot(), id, 0);
  if (!file) return [];
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const out = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v.type !== "user" && v.type !== "assistant") continue;
    const text = extractText(v).trim();
    if (!text || text.startsWith("<local-command")) continue;
    out.push({
      role: v.type,
      text,
      timestamp: v.timestamp ? Date.parse(v.timestamp) || null : null,
    });
  }
  return out;
}

function findFile(dir, id, depth) {
  if (depth > 2) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, id, depth + 1);
      if (hit) return hit;
    } else if (e.name === `${id}.jsonl`) {
      return full;
    }
  }
  return null;
}

/** content 可能是字符串，也可能是 block 数组（text / thinking / tool_use） */
function extractText(v) {
  const content = (v.message && v.message.content) ?? v.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

module.exports = { list, read };
