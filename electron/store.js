const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * 应用自身的元数据（不写任何平台的数据）：
 *   - archived: 本地归档标记，用于「仅归档可删」这条规则
 *   - trash:    隔离区清单
 */
const appDataBase = () =>
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

const legacyRoot = () => path.join(appDataBase(), "chat-session-manager");
const newRoot = () => path.join(appDataBase(), "session-dock");

let migrated = false;
function migrateLegacyRoot() {
  if (migrated) return;
  migrated = true;
  const oldDir = legacyRoot();
  const curDir = newRoot();
  if (!fs.existsSync(oldDir) || fs.existsSync(path.join(curDir, "meta.json"))) return;

  try {
    fs.mkdirSync(curDir, { recursive: true });
    for (const entry of ["meta.json", "trash", "exports", "cursor-titles.json", "pi-index.json", "sessions-cache.json"]) {
      const src = path.join(oldDir, entry);
      const dst = path.join(curDir, entry);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true });
      }
    }
    // 同步更新 meta.json 里隔离区记录的目录路径
    const mf = path.join(curDir, "meta.json");
    if (fs.existsSync(mf)) {
      const meta = JSON.parse(fs.readFileSync(mf, "utf8"));
      if (Array.isArray(meta.trash)) {
        for (const t of meta.trash) {
          if (typeof t.dir === "string" && t.dir.startsWith(oldDir)) {
            t.dir = curDir + t.dir.slice(oldDir.length);
          }
        }
        fs.writeFileSync(mf, JSON.stringify(meta, null, 2), "utf8");
      }
    }
  } catch {
    /* 迁移失败时不阻塞启动 */
  }
}

const root = () => {
  migrateLegacyRoot();
  return newRoot();
};

const metaFile = () => path.join(root(), "meta.json");
const trashRoot = () => path.join(root(), "trash");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaFile(), "utf8"));
  } catch {
    return { archived: {}, trash: [] };
  }
}

function writeMeta(meta) {
  ensureDir(root());
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2), "utf8");
}

const keyOf = (platform, id) => `${platform}:${id}`;

function isArchived(platform, id) {
  return !!readMeta().archived[keyOf(platform, id)];
}

function setArchived(platform, id, value) {
  const meta = readMeta();
  const k = keyOf(platform, id);
  if (value) meta.archived[k] = { at: Date.now() };
  else delete meta.archived[k];
  writeMeta(meta);
  return !!value;
}

/** 批量归档：只读一次 meta.json，写一次盘 */
function setArchivedMany(items, value) {
  const meta = readMeta();
  for (const it of items) {
    const k = keyOf(it.platform, it.id);
    if (value) meta.archived[k] = { at: Date.now() };
    else delete meta.archived[k];
  }
  writeMeta(meta);
  return items.length;
}

function newTrashDir(platform, id) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(trashRoot(), `${stamp}_${platform}_${id.slice(0, 8)}`);
  ensureDir(dir);
  return dir;
}

function addTrash(record) {
  const meta = readMeta();
  meta.trash.unshift(record);
  writeMeta(meta);
}

function listTrash() {
  return readMeta().trash;
}

function dropTrashRecord(trashId) {
  const meta = readMeta();
  const item = meta.trash.find((t) => t.trashId === trashId);
  meta.trash = meta.trash.filter((t) => t.trashId !== trashId);
  writeMeta(meta);
  return item || null;
}

/** 递归统计目录体积，用于「一键清空」时告知将释放多少空间 */
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return total;
}

/** 清空隔离区：先算体积再删，返回清掉了多少 */
function clearTrash() {
  const meta = readMeta();
  const items = meta.trash || [];
  let bytes = 0;
  for (const it of items) bytes += dirSize(it.dir);
  for (const it of items) removeTrashDir(it.dir);
  meta.trash = [];
  writeMeta(meta);
  return { count: items.length, bytes };
}

function removeTrashDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const snapshotFile = () => path.join(root(), "sessions-cache.json");

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
    ensureDir(root());
    const tmp = `${snapshotFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), ...data }), "utf8");
    fs.renameSync(tmp, snapshotFile());
  } catch {
    /* 快照写失败不影响功能 */
  }
}

module.exports = {
  root,
  trashRoot,
  isArchived,
  setArchived,
  setArchivedMany,
  newTrashDir,
  addTrash,
  listTrash,
  clearTrash,
  dropTrashRecord,
  removeTrashDir,
  readSnapshot,
  writeSnapshot,
};
