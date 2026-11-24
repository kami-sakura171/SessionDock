const codex = require("./codex");
const claude = require("./claude");
const cursor = require("./cursor");
const antigravity = require("./antigravity");
const hermes = require("./hermes");
const pi = require("./pi");
const vscode = require("./vscode");
const kiro = require("./kiro");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../store");

/**
 * 平台适配器注册表。新增平台只需实现 list() / read(id)，
 * 在这里挂上并补一个 LABELS 条目，上层完全不用改。
 */
const ADAPTERS = { codex, claude, cursor, antigravity, hermes, pi, vscode, kiro };

const LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  antigravity: "Antigravity",
  hermes: "Hermes",
  pi: "Pi",
  vscode: "VS Code",
  kiro: "Kiro",
};

function listAll() {
  const sessions = [];
  const platforms = [];

  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    let rows = [];
    let error = null;
    try {
      rows = adapter.list();
    } catch (e) {
      error = e.message;
    }
    for (const r of rows) r.archived = r.archived || store.isArchived(r.platform, r.id);
    sessions.push(...rows);
    platforms.push({ platform: id, label: LABELS[id], count: rows.length, error });
  }

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { sessions, platforms };
}

/**
 * 60 秒内存缓存：Cursor 的 2GB 库每次全扫要 1.4s，没必要每刷新一次都付这个成本。
 * force=true 时绕过缓存（前端「刷新」按钮用）。
 */
let cache = null;
let cacheAt = 0;
const TTL = 60_000;

function listCached(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  cache = listAll();
  cacheAt = Date.now();
  return cache;
}

/** 上次扫描结果的快照，用于启动时秒开列表 */
const snapshotFile = () => path.join(store.root(), "sessions-cache.json");

function readSnapshot() {
  try {
    const d = JSON.parse(fs.readFileSync(snapshotFile(), "utf8"));
    if (d && Array.isArray(d.sessions) && Array.isArray(d.platforms)) return d;
  } catch {
    /* 没有快照就走真扫描 */
  }
  return null;
}

function writeSnapshot(data) {
  try {
    fs.mkdirSync(store.root(), { recursive: true });
    const tmp = `${snapshotFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), ...data }), "utf8");
    fs.renameSync(tmp, snapshotFile());
  } catch {
    /* 快照写失败不影响功能 */
  }
}

/** 数据变了只作废缓存，不立刻重扫；下次真正需要列表时再算一次 */
function invalidate() {
  cache = null;
  cacheAt = 0;
}

function read(platform, id) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`暂未支持的平台: ${platform}`);
  return adapter.read(id);
}

function exportMarkdown(platform, id, title) {
  const messages = read(platform, id);
  const lines = [
    `# ${title || id}`,
    "",
    `- 平台: ${LABELS[platform] || platform}`,
    `- 会话 ID: \`${id}\``,
    "",
    "---",
    "",
  ];
  for (const m of messages) {
    const who = m.role === "user" ? "👤 用户" : m.role === "assistant" ? "🤖 助手" : "系统";
    lines.push(`### ${who}`, "", m.text.trim(), "");
  }
  return lines.join("\n");
}

module.exports = {
  listAll,
  listCached,
  invalidate,
  readSnapshot,
  writeSnapshot,
  read,
  exportMarkdown,
  ADAPTERS,
  LABELS,
};
