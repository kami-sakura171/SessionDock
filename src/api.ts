import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

export type Session = {
  id: string;
  platform: string;
  title: string;
  project: string | null;
  cwd: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  archived: boolean;
  account: string | null;
  path: string;
};

export type TrashItem = {
  trashId: string;
  platform: string;
  id: string;
  title: string;
  deletedAt: number;
  dir: string;
  kind: "db" | "file";
};

export type Message = {
  role: string;
  text: string;
  timestamp: number | null;
};

export type PlatformInfo = {
  platform: string;
  label: string;
  count: number;
  error: string | null;
};

export type DirItem = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
};

export type DirListing = {
  current: string;
  parent: string | null;
  items: DirItem[];
  shortcuts: { label: string; path: string }[];
  drives: string[];
};

export type SessionsPayload = { sessions: Session[]; platforms: PlatformInfo[] };

export const listSessions = (force = false) => invoke<SessionsPayload>("sessions_list", { force });

/**
 * Rust 端扫描完成后 emit("sessions:updated")。
 * listen() 是异步的，这里包成同步返回的退订函数，保持原 window.api 的签名。
 */
export const onSessionsUpdated = (cb: (data: SessionsPayload) => void) => {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen<SessionsPayload>("sessions:updated", (e) => cb(e.payload))
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => {
      /* 监听失败时列表仍能靠手动刷新工作 */
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
};

export const readSession = (platform: string, id: string) =>
  invoke<Message[]>("sessions_read", { platform, id });
export const exportMarkdown = (platform: string, id: string, title: string) =>
  invoke<string>("sessions_export", { platform, id, title });
export const exportFile = (platform: string, id: string, title: string, targetPath?: string) =>
  invoke<{ path: string; bytes: number }>("file_export", { platform, id, title, targetPath });
export const reveal = (filePath: string) => invoke<boolean>("file_reveal", { filePath });
export const listDir = (dirPath?: string) => invoke<DirListing>("fs_list_dir", { dirPath });
export const mkdir = (parentDir: string, name: string) =>
  invoke<string>("fs_mkdir", { parentDir, name });
export const archive = (platform: string, id: string, value: boolean) =>
  invoke<boolean>("sessions_archive", { platform, id, value });
export const archiveMany = (items: { platform: string; id: string }[], value: boolean) =>
  invoke<number>("sessions_archive_many", { items, value });
export const exportMany = (items: Session[], targetDir?: string) =>
  invoke<{ ok: number; fail: number; dir: string }>("sessions_export_many", { items, targetDir });
export const removeMany = (items: Session[], options?: { exportFirst?: boolean }) =>
  invoke<{ deleted: number; skipped: number; exported: number; errors: string[] }>(
    "sessions_delete_many",
    { items, options },
  );
export const remove = (
  platform: string,
  id: string,
  session: Session,
  options?: { exportFirst?: boolean },
) =>
  invoke<{ record: TrashItem; exported: { path: string; bytes: number } | null }>("sessions_delete", {
    platform,
    id,
    session,
    options,
  });
export const trashList = () => invoke<TrashItem[]>("trash_list");
export const trashRestore = (trashId: string) => invoke<boolean>("trash_restore", { trashId });
export const trashPurge = (trashId: string) => invoke<boolean>("trash_purge", { trashId });
export const trashPurgeAll = () => invoke<{ count: number; bytes: number }>("trash_purge_all");

/** 自绘标题栏按钮：直接操作当前窗口 */
export const win = {
  minimize: () => void getCurrentWindow().minimize(),
  toggleMaximize: () => {
    const w = getCurrentWindow();
    void (async () => {
      if (await w.isMaximized()) await w.unmaximize();
      else await w.maximize();
    })();
  },
  close: () => void getCurrentWindow().close(),
};

/** 无边框窗口的标题栏拖拽：单击拖动、双击切换最大化（按钮区除外） */
export function startWindowDrag(e: { button: number; detail: number; target: EventTarget | null }) {
  if (e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest(".winbtn")) return;
  if (e.detail === 2) win.toggleMaximize();
  else void getCurrentWindow().startDragging();
}

/**
 * 预览里的 http(s) 链接一律交给系统浏览器，避免 WebView2 把主窗口导航走。
 * 捕获阶段拦截，Markdown 是 dangerouslySetInnerHTML 渲染的，没法逐个加 handler。
 */
export function installExternalLinkHandler() {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    void openUrl(href).catch(() => {
      /* 打开失败不影响界面 */
    });
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);
}
