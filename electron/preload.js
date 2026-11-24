const { contextBridge, ipcRenderer } = require("electron");

// 只暴露白名单方法，渲染进程拿不到 Node 能力
contextBridge.exposeInMainWorld("api", {
  listSessions: (force) => ipcRenderer.invoke("sessions:list", force),
  readSession: (platform, id) => ipcRenderer.invoke("sessions:read", platform, id),
  exportMarkdown: (platform, id, title) => ipcRenderer.invoke("sessions:export", platform, id, title),
  exportFile: (platform, id, title, targetPath) =>
    ipcRenderer.invoke("file:export", platform, id, title, targetPath),
  reveal: (filePath) => ipcRenderer.invoke("file:reveal", filePath),
  listDir: (dirPath) => ipcRenderer.invoke("fs:list-dir", dirPath),
  mkdir: (parentDir, name) => ipcRenderer.invoke("fs:mkdir", parentDir, name),
  archive: (platform, id, value) => ipcRenderer.invoke("sessions:archive", platform, id, value),
  archiveMany: (items, value) => ipcRenderer.invoke("sessions:archive-many", items, value),
  exportMany: (items, targetDir) => ipcRenderer.invoke("sessions:export-many", items, targetDir),
  removeMany: (items, options) => ipcRenderer.invoke("sessions:delete-many", items, options),
  remove: (platform, id, session, options) => ipcRenderer.invoke("sessions:delete", platform, id, session, options),
  trashList: () => ipcRenderer.invoke("trash:list"),
  trashRestore: (trashId) => ipcRenderer.invoke("trash:restore", trashId),
  trashPurge: (trashId) => ipcRenderer.invoke("trash:purge", trashId),
  trashPurgeAll: () => ipcRenderer.invoke("trash:purge-all"),
  onSessionsUpdated: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("sessions:updated", handler);
    return () => ipcRenderer.removeListener("sessions:updated", handler);
  },
  win: {
    minimize: () => ipcRenderer.send("win:minimize"),
    toggleMaximize: () => ipcRenderer.send("win:toggle-max"),
    close: () => ipcRenderer.send("win:close"),
  },
});
