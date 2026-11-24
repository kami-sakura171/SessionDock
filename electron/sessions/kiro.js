const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Kiro 是 VS Code 分支，聊天落盘在 globalStorage/kiro.kiroagent 下。
 * 该目录在部分版本里为空（会话存在云端），此时按「已检测到、无本地会话」处理，
 * 不要伪造数据。
 */
const agentRoot = () =>
  path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Kiro", "User", "globalStorage", "kiro.kiroagent"
  );

function transcriptFiles(dir, out, depth) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) transcriptFiles(full, out, depth + 1);
    else if (e.name.endsWith(".jsonl") || e.name.endsWith(".json")) out.push(full);
  }
}

function list() {
  const root = agentRoot();
  if (!fs.existsSync(root)) return [];
  const files = [];
  transcriptFiles(root, files, 0);

  const out = [];
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter(Boolean);
    let title = "";
    let count = 0;
    for (const line of lines) {
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const text = d.text || d.content || "";
      if (!text || typeof text !== "string") continue;
      count++;
      if (!title) title = text.split("\n").find((l) => l.trim()) || "";
    }
    if (count === 0) continue;
    const st = fs.statSync(file);
    out.push({
      id: path.basename(file).replace(/\.(jsonl|json)$/, ""),
      platform: "kiro",
      title: (title || "(未命名会话)").slice(0, 120),
      project: null,
      cwd: null,
      createdAt: st.mtimeMs,
      updatedAt: st.mtimeMs,
      messageCount: count,
      archived: false,
      account: null,
      path: file,
    });
  }
  return out;
}

function read(id) {
  const root = agentRoot();
  if (!fs.existsSync(root)) return [];
  const files = [];
  transcriptFiles(root, files, 0);
  const file = files.find((f) => path.basename(f).startsWith(id));
  if (!file) return [];

  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const text = typeof (d.text || d.content) === "string" ? (d.text || d.content).trim() : "";
    if (!text) continue;
    out.push({
      role: d.role === "assistant" || d.type === "assistant" ? "assistant" : "user",
      text,
      timestamp: null,
    });
  }
  return out;
}

module.exports = { list, read };
