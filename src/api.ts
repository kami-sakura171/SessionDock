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

type DesktopApi = {
  listSessions: (force?: boolean) => Promise<{ sessions: Session[]; platforms: PlatformInfo[] }>;
  readSession: (platform: string, id: string) => Promise<Message[]>;
  exportMarkdown: (platform: string, id: string, title: string) => Promise<string>;
  exportFile: (
    platform: string,
    id: string,
    title: string,
    targetPath?: string,
  ) => Promise<{ path: string; bytes: number }>;
  reveal: (filePath: string) => Promise<boolean>;
  listDir: (dirPath?: string) => Promise<DirListing>;
  mkdir: (parentDir: string, name: string) => Promise<string>;
  archive: (platform: string, id: string, value: boolean) => Promise<boolean>;
  archiveMany: (items: { platform: string; id: string }[], value: boolean) => Promise<number>;
  exportMany: (items: Session[], targetDir?: string) => Promise<{ ok: number; fail: number; dir: string }>;
  removeMany: (
    items: Session[],
    options?: { exportFirst?: boolean },
  ) => Promise<{ deleted: number; skipped: number; exported: number; errors: string[] }>;
  remove: (
    platform: string,
    id: string,
    session: Session,
    options?: { exportFirst?: boolean },
  ) => Promise<{ record: TrashItem; exported: { path: string; bytes: number } | null }>;
  trashList: () => Promise<TrashItem[]>;
  trashRestore: (trashId: string) => Promise<boolean>;
  trashPurge: (trashId: string) => Promise<boolean>;
  trashPurgeAll: () => Promise<{ count: number; bytes: number }>;
  onSessionsUpdated: (
    cb: (data: { sessions: Session[]; platforms: PlatformInfo[] }) => void,
  ) => () => void;
  win: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
  };
};

declare global {
  interface Window {
    api: DesktopApi;
  }
}

export const listSessions = (force = false) => window.api.listSessions(force);
export const onSessionsUpdated = (cb: (data: { sessions: Session[]; platforms: PlatformInfo[] }) => void) =>
  window.api.onSessionsUpdated(cb);
export const readSession = (platform: string, id: string) => window.api.readSession(platform, id);
export const exportMarkdown = (platform: string, id: string, title: string) =>
  window.api.exportMarkdown(platform, id, title);
export const exportFile = (platform: string, id: string, title: string, targetPath?: string) =>
  window.api.exportFile(platform, id, title, targetPath);
export const reveal = (filePath: string) => window.api.reveal(filePath);
export const listDir = (dirPath?: string) => window.api.listDir(dirPath);
export const mkdir = (parentDir: string, name: string) => window.api.mkdir(parentDir, name);
export const archive = (platform: string, id: string, value: boolean) => window.api.archive(platform, id, value);
export const archiveMany = (items: { platform: string; id: string }[], value: boolean) =>
  window.api.archiveMany(items, value);
export const exportMany = (items: Session[], targetDir?: string) => window.api.exportMany(items, targetDir);
export const removeMany = (items: Session[], options?: { exportFirst?: boolean }) =>
  window.api.removeMany(items, options);
export const remove = (
  platform: string,
  id: string,
  session: Session,
  options?: { exportFirst?: boolean },
) => window.api.remove(platform, id, session, options);
export const trashList = () => window.api.trashList();
export const trashRestore = (trashId: string) => window.api.trashRestore(trashId);
export const trashPurge = (trashId: string) => window.api.trashPurge(trashId);
export const trashPurgeAll = () => window.api.trashPurgeAll();
