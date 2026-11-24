const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const brainRoot = () =>
  path.join(process.env.USERPROFILE || os.homedir(), ".gemini", "antigravity", "brain");

/** 递归收集某个 brain 目录下所有 transcript 分片，按文件名排序（00000000、00000001…） */
function chunksOf(brainDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith(".jsonl") && full.includes(`${path.sep}transcript${path.sep}`)) out.push(full);
    }
  };
  walk(brainDir, 0);
  return out.sort();
}

const stripTags = (s) =>
  String(s || "")
    .replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/g, "$1")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "")
    .trim();

function parseBrain(brainDir) {
  const messages = [];
  let title = "";
  let updatedAt = null;

  for (const file of chunksOf(brainDir)) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const when = d.created_at ? Date.parse(d.created_at) || null : null;
      if (when) updatedAt = Math.max(updatedAt || 0, when);

      if (d.type === "USER_INPUT") {
        const text = stripTags(d.content);
        if (!text) continue;
        if (!title) title = text.split("\n").find((l) => l.trim()) || "";
        messages.push({ role: "user", text, timestamp: when });
      } else if (d.type === "PLANNER_RESPONSE") {
        const text = stripTags(d.content);
        if (!text) continue; // 工具调用没有正文，跳过
        messages.push({ role: "assistant", text, timestamp: when });
      }
    }
  }

  return { messages, title: (title || "(未命名会话)").slice(0, 120), updatedAt };
}

function list() {
  const root = brainRoot();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  const out = [];
  for (const e of dirs) {
    const dir = path.join(root, e.name);
    const { messages, title, updatedAt } = parseBrain(dir);
    if (messages.length === 0) continue;
    out.push({
      id: e.name,
      platform: "antigravity",
      title,
      project: null,
      cwd: null,
      createdAt: updatedAt,
      updatedAt,
      messageCount: messages.length,
      archived: false,
      account: null,
      path: dir,
    });
  }
  return out;
}

function read(id) {
  const dir = path.join(brainRoot(), id);
  if (!fs.existsSync(dir)) return [];
  return parseBrain(dir).messages;
}

module.exports = { list, read };
