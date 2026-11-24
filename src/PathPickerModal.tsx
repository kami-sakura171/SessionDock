import { useEffect, useState } from "react";
import { listDir, mkdir } from "./api";
import type { DirItem, DirListing } from "./api";

type Props = {
  mode: "save-file" | "pick-dir";
  defaultFileName?: string;
  onCancel: () => void;
  onConfirm: (targetPath: string) => void | Promise<void>;
};

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

const fmtDate = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function PathPickerModal({ mode, defaultFileName = "session.md", onCancel, onConfirm }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [fileName, setFileName] = useState(defaultFileName);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function navigate(dir?: string) {
    setLoading(true);
    setErr("");
    try {
      const data = await listDir(dir);
      setListing(data);
      setPathInput(data.current);
      setSelectedPath(null);
      localStorage.setItem("lastExportDir", data.current);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*/, ""));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem("lastExportDir") || undefined;
    navigate(saved);
  }, []);

  async function handleCreateFolder() {
    if (!listing || !newFolderName.trim()) return;
    setErr("");
    try {
      const created = await mkdir(listing.current, newFolderName.trim());
      setNewFolderName("");
      setNewFolderMode(false);
      await navigate(created);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*/, ""));
    }
  }

  async function handleConfirm(overrideName?: string) {
    if (!listing || submitting) return;
    setSubmitting(true);
    try {
      if (mode === "pick-dir") {
        await onConfirm(listing.current);
      } else {
        const raw = (overrideName ?? fileName).trim() || defaultFileName;
        const finalName = raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
        const sep = listing.current.endsWith("\\") ? "" : "\\";
        await onConfirm(`${listing.current}${sep}${finalName}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function onItemClick(item: DirItem) {
    setSelectedPath(item.path);
    if (mode === "save-file" && !item.isDir) {
      setFileName(item.name);
    }
  }

  function onItemDoubleClick(item: DirItem) {
    if (item.isDir) {
      navigate(item.path);
    } else if (mode === "save-file") {
      setFileName(item.name);
      handleConfirm(item.name);
    }
  }

  const visibleItems = (listing?.items ?? []).filter((it) => (mode === "pick-dir" ? it.isDir : true));

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{mode === "save-file" ? "选择导出路径" : "选择批量导出文件夹"}</b>
          <span className="hint">{mode === "save-file" ? "保存 Markdown 文件" : "将所选会话导出到目标文件夹"}</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onCancel} title="关闭">✕</button>
        </div>

        <div className="picker-nav">
          <button
            type="button"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && navigate(listing.parent)}
            title="返回上一级目录"
          >
            上级
          </button>
          <input
            type="text"
            className="picker-path"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(pathInput.trim());
            }}
            placeholder="输入或粘贴目录路径，按回车跳转"
          />
          <button
            type="button"
            onClick={() => {
              setNewFolderMode((v) => !v);
              setNewFolderName("");
            }}
          >
            新建文件夹
          </button>
        </div>

        {newFolderMode && (
          <div className="picker-mkdir">
            <input
              type="text"
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
                if (e.key === "Escape") setNewFolderMode(false);
              }}
              placeholder="输入新文件夹名称"
            />
            <button type="button" className="primary" onClick={handleCreateFolder}>创建</button>
            <button type="button" onClick={() => setNewFolderMode(false)}>取消</button>
          </div>
        )}

        {err && <div className="picker-err">{err}</div>}

        <div className="picker-body">
          <aside className="picker-side">
            <div className="picker-sec">常用位置</div>
            {(listing?.shortcuts ?? []).map((sc) => (
              <div
                key={sc.path}
                className={`picker-place ${listing?.current === sc.path ? "active" : ""}`}
                onClick={() => navigate(sc.path)}
                title={sc.path}
              >
                {sc.label}
              </div>
            ))}
            <div className="picker-sec" style={{ marginTop: 10 }}>本地磁盘</div>
            {(listing?.drives ?? []).map((drv) => (
              <div
                key={drv}
                className={`picker-place ${listing?.current === drv ? "active" : ""}`}
                onClick={() => navigate(drv)}
              >
                {drv}
              </div>
            ))}
          </aside>

          <div className="picker-list">
            {loading && <div className="empty">读取目录中…</div>}
            {!loading && visibleItems.length === 0 && (
              <div className="empty">{mode === "pick-dir" ? "此目录下没有子文件夹" : "此目录下没有子文件夹或 .md 文件"}</div>
            )}
            {!loading &&
              visibleItems.map((it) => (
                <div
                  key={it.path}
                  className={`picker-row ${selectedPath === it.path ? "sel" : ""}`}
                  onClick={() => onItemClick(it)}
                  onDoubleClick={() => onItemDoubleClick(it)}
                >
                  <span className={`picker-ico ${it.isDir ? "dir" : "file"}`} aria-hidden="true">
                    {it.isDir ? (
                      <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
                        <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.17a1.5 1.5 0 0 1 1.06.44l.83.83c.14.14.33.23.53.23H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <path d="M3.5 1.5h6l3 3v10h-9v-13z" />
                        <path d="M9.5 1.5v3h3" />
                      </svg>
                    )}
                  </span>
                  <span className="picker-name" title={it.name}>{it.name}</span>
                  <span className="picker-meta mono">{it.isDir ? "" : fmtSize(it.size)}</span>
                  <span className="picker-time mono">{fmtDate(it.mtime)}</span>
                </div>
              ))}
          </div>
        </div>

        <div className="picker-foot">
          {mode === "save-file" ? (
            <>
              <span className="hint" style={{ flex: "none" }}>文件名</span>
              <input
                type="text"
                className="picker-filename"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConfirm();
                }}
              />
            </>
          ) : (
            <div className="picker-target mono" title={listing?.current}>
              导出目录：{listing?.current ?? "…"}
            </div>
          )}
          <button type="button" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={!listing || submitting}
            onClick={() => handleConfirm()}
          >
            {submitting ? "导出中…" : mode === "save-file" ? "保存导出" : "导出到此文件夹"}
          </button>
        </div>
      </div>
    </div>
  );
}
