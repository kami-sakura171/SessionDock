const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userRoot = () =>
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User");

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** workspace.json 里的 folder 字段能给出项目名 */
function projectOf(workspaceDir) {
  const j = parse(readFile(path.join(workspaceDir, "workspace.json")));
  const p = (j && (j.folder || j.workspace)) || "";
  return p ? p.replace(/^file:\/\/\/?/, "").split(/[\\/]/).filter(Boolean).pop() || null : null;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function list() {
  const root = userRoot();
  const wsRoot = path.join(root, "workspaceStorage");
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(wsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  const out = [];
  for (const ws of workspaces) {
    const wsDir = path.join(wsRoot, ws.name);
    const chatDir = path.join(wsDir, "chatSessions");
    let files = [];
    try {
      files = fs.readdirSync(chatDir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    const project = projectOf(wsDir);

    for (const f of files) {
      const d = parse(readFile(path.join(chatDir, f)) || "");
      if (!d || !Array.isArray(d.requests) || d.requests.length === 0) continue;

      const first = d.requests[0];
      const text = (first.message && first.message.text) || "";
      out.push({
        id: d.sessionId || path.basename(f, ".json"),
        platform: "vscode",
        title: text.split("\n").find((l) => l.trim())?.slice(0, 120) || "(未命名会话)",
        project,
        cwd: null,
        createdAt: d.creationDate || null,
        updatedAt: d.lastMessageDate || d.creationDate || null,
        messageCount: d.requests.length * 2,
        archived: false,
        account: null,
        path: path.join(chatDir, f),
      });
    }
  }
  return out;
}

function read(id) {
  const root = userRoot();
  const wsRoot = path.join(root, "workspaceStorage");
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(wsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  for (const ws of workspaces) {
    const file = path.join(wsRoot, ws.name, "chatSessions", `${id}.json`);
    const d = parse(readFile(file) || "");
    if (!d || !Array.isArray(d.requests)) continue;

    const out = [];
    for (const req of d.requests) {
      const q = (req.message && req.message.text) || "";
      if (q.trim()) out.push({ role: "user", text: q.trim(), timestamp: req.timestamp || null });

      const parts = Array.isArray(req.response) ? req.response : [];
      const a = parts
        .map((p) => (typeof p.value === "string" ? p.value : typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (a) out.push({ role: "assistant", text: a, timestamp: req.timestamp || null });
    }
    return out;
  }
  return [];
}

module.exports = { list, read };
