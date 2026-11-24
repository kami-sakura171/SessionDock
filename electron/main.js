const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const store = require("./store");

// 延迟加载重模块（8 个平台适配器 + node:sqlite），避免拖慢窗口创建与首屏渲染
let _sessions = null;
let _trash = null;
const getSessions = () => (_sessions ??= require("./sessions"));
const getTrash = () => (_trash ??= require("./delete"));

const DEV_URL = "http://localhost:1420";

/* ---------- 会话扫描调度 ---------- */
function appLog(msg) {
  try {
    const file = path.join(store.root(), "app.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

let scanWorker = null;
let scanSeq = 0;
let dataGen = 0; // 每次增删改 +1，用来丢弃过期的扫描结果
let inflightScan = null;
let latestData = null;
let lastScanAt = 0;
let lastScanGen = -1;

function ensureScanWorker() {
  if (scanWorker) return scanWorker;
  scanWorker = new Worker(path.join(__dirname, "sessions", "worker.js"));
  scanWorker.on("error", (e) => {
    appLog(`worker error: ${e.message}`);
    scanWorker = null;
  });
  scanWorker.unref();
  return scanWorker;
}

function broadcastSessions(data) {
  latestData = data;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("sessions:updated", data);
  }
}

function runScan() {
  if (inflightScan) return inflightScan;

  const gen = dataGen;
  // 2 秒内同代数的重复请求直接复用结果，避免启动时被调用两次而扫两遍
  if (latestData && lastScanGen === gen && Date.now() - lastScanAt < 2000) {
    return Promise.resolve(latestData);
  }
  const seq = ++scanSeq;
  let worker;
  try {
    worker = ensureScanWorker();
  } catch {
    // 工作线程起不来就退回主线程，功能不能丢
    const data = getSessions().listAll();
    store.writeSnapshot(data);
    return Promise.resolve(data);
  }

  inflightScan = new Promise((resolve) => {
    const onError = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      inflightScan = null;
      try {
        const data = getSessions().listAll();
        store.writeSnapshot(data);
        broadcastSessions(data);
        resolve(data);
      } catch {
        resolve(latestData || { sessions: [], platforms: [] });
      }
    };
    worker.once("error", onError);

    const onMessage = (m) => {
      if (!m || m.seq !== seq) return;
      worker.off("message", onMessage);
      worker.off("error", onError);
      inflightScan = null;

      if (m.type === "error") {
        resolve(latestData || { sessions: [], platforms: [], error: m.message });
        return;
      }
      if (m.gen !== dataGen) {
        // 扫描期间有增删改，重扫一次再给结果
        runScan().then(resolve);
        return;
      }
      appLog(`scan ok gen=${m.gen} n=${m.data.sessions.length}`);
      store.writeSnapshot(m.data);
      broadcastSessions(m.data);
      lastScanAt = Date.now();
      lastScanGen = m.gen;
      resolve(m.data);
    };
    worker.on("message", onMessage);
    worker.postMessage({ type: "scan", gen, seq });
  });

  return inflightScan;
}

function invalidateAll() {
  dataGen++;
  if (_sessions) _sessions.invalidate();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 620,
    frame: false,              // 自绘标题栏
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#f7f4ee",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // 预览里的链接一律交给系统浏览器，别让主窗口被导航走（否则界面会白/黑）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith(DEV_URL)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 黑屏类问题最难查，这里把加载失败与渲染进程崩溃落到日志文件
  win.webContents.on("did-fail-load", (_e, code, desc, url) => appLog(`did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on("render-process-gone", (_e, details) => appLog(`render-process-gone ${JSON.stringify(details)}`));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) appLog(`console(${level}) ${message}`);
  });

  if (!app.isPackaged) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

/* ---------- IPC ---------- */

ipcMain.handle("sessions:list", async (_e, force) => {
  appLog(`sessions:list force=${force}`);
  if (!force) {
    // 先用上次的快照秒开，同时错峰后台刷新（避免与首屏渲染抢 CPU/磁盘）
    const snap = latestData || store.readSnapshot();
    if (snap) {
      latestData = snap;
      setTimeout(() => runScan(), 350);
      return snap;
    }
  }
  return runScan();
});

ipcMain.handle("sessions:read", async (_e, platform, id) => {
  return getSessions().read(platform, id);
});

ipcMain.handle("sessions:export", async (_e, platform, id, title) => {
  return getSessions().exportMarkdown(platform, id, title);
});

ipcMain.handle("sessions:archive", async (_e, platform, id, value) => {
  store.setArchived(platform, id, value);
  invalidateAll(); // 只作废，不重扫
  return true;
});

ipcMain.handle("sessions:delete", async (_e, platform, id, session, options) => {
  const archived = store.isArchived(platform, id) || !!(session && session.archived);
  if (!archived) throw new Error("仅允许删除已归档的会话");

  let exported = null;
  if (options && options.exportFirst) {
    const md = getSessions().exportMarkdown(platform, id, session.title);
    exported = writeExport(platform, id, session.title, md);
  }

  const record = getTrash().remove(platform, id, session);
  store.setArchived(platform, id, false);
  invalidateAll();
  return { record, exported };
});

ipcMain.handle("sessions:archive-many", async (_e, items, value) => {
  store.setArchivedMany(items, value);
  invalidateAll();
  return items.length;
});

ipcMain.handle("sessions:export-many", async (_e, items) => {
  let ok = 0;
  let fail = 0;
  const s = getSessions();
  for (const it of items) {
    try {
      const md = s.exportMarkdown(it.platform, it.id, it.title);
      writeExport(it.platform, it.id, it.title, md);
      ok++;
    } catch {
      fail++;
    }
  }
  return { ok, fail, dir: EXPORT_DIR() };
});

ipcMain.handle("sessions:delete-many", async (_e, items, options) => {
  let deleted = 0;
  let skipped = 0;
  let exported = 0;
  const errors = [];
  const s = getSessions();
  const t = getTrash();

  for (const it of items) {
    const archived = store.isArchived(it.platform, it.id) || !!it.archived;
    if (!archived) {
      skipped++;
      continue;
    }
    try {
      if (options && options.exportFirst) {
        const md = s.exportMarkdown(it.platform, it.id, it.title);
        writeExport(it.platform, it.id, it.title, md);
        exported++;
      }
      t.remove(it.platform, it.id, it);
      store.setArchived(it.platform, it.id, false);
      deleted++;
    } catch (e) {
      errors.push(`${it.title}: ${e.message}`);
    }
  }

  invalidateAll();
  return { deleted, skipped, exported, errors };
});

ipcMain.handle("trash:list", async () => store.listTrash());

ipcMain.handle("trash:restore", async (_e, trashId) => {
  const ok = getTrash().restore(trashId);
  invalidateAll();
  return ok;
});

ipcMain.handle("trash:purge", async (_e, trashId) => getTrash().purge(trashId));

ipcMain.handle("trash:purge-all", async () => store.clearTrash());

const EXPORT_DIR = () => path.join(store.root(), "exports");

function safeName(s) {
  return String(s || "session").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").slice(0, 60);
}

/** 导出到应用自己的目录，不弹系统对话框；重名时自动加时间戳 */
function writeExport(platform, id, title, content) {
  const dir = EXPORT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const file = path.join(dir, `${safeName(title)}_${platform}_${stamp}.md`);
  fs.writeFileSync(file, content, "utf8");
  return { path: file, bytes: Buffer.byteLength(content, "utf8") };
}

ipcMain.handle("file:export", async (_e, platform, id, title) => {
  const md = getSessions().exportMarkdown(platform, id, title);
  return writeExport(platform, id, title, md);
});

ipcMain.handle("file:reveal", async (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  else shell.openPath(EXPORT_DIR());
  return true;
});

ipcMain.on("win:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("win:toggle-max", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on("win:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());

/* ---------- 生命周期 ---------- */

app.whenReady().then(() => {
  createWindow();
  // 在渲染进程加载 HTML/JS 的间隙预热快照到内存
  if (!latestData) latestData = store.readSnapshot();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
