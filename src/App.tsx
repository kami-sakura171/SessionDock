import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  archive,
  archiveMany,
  exportMarkdown,
  exportMany,
  listSessions,
  readSession,
  exportFile,
  remove,
  removeMany,
  reveal,
  trashList,
  trashPurge,
  trashPurgeAll,
  trashRestore,
} from "./api";
import type { Message, PlatformInfo, Session, TrashItem } from "./api";
import PathPickerModal from "./PathPickerModal";

const Markdown = lazy(() => import("./Markdown"));

const PLATFORM_COLOR: Record<string, string> = {
  codex: "#4a7392",
  claude: "#c15f3c",
  cursor: "#6b8a63",
  antigravity: "#8a6a9e",
  hermes: "#a8823f",
  pi: "#6f7fa8",
  vscode: "#4f7d7a",
  kiro: "#a3607a",
};

const fmtTime = (ms: number | null) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<string>("all");
  const [selected, setSelected] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [toast, setToast] = useState("");
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [mapOpen, setMapOpen] = useState(false);
  const [railTop, setRailTop] = useState<number | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const tocListRef = useRef<HTMLDivElement>(null);
  const mapCloseTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const scrollRaf = useRef<number>(0);
  const manualJumpUntil = useRef<number>(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const [drawerWidth, setDrawerWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("drawerWidth"));
    return Number.isFinite(saved) && saved >= 320 ? saved : 460;
  });
  const [exportFirst, setExportFirst] = useState(true);
  const [batch, setBatch] = useState(false);
  const [archFilter, setArchFilter] = useState<"all" | "unarchived" | "archived">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmBox, setConfirmBox] = useState<
    { title: string; body: string; confirmText: string; danger?: boolean; exportOption?: boolean; run: () => void | Promise<void> } | null
  >(null);
  const [pathPicker, setPathPicker] = useState<{
    mode: "save-file" | "pick-dir";
    defaultFileName?: string;
    onConfirm: (targetPath: string) => Promise<void>;
  } | null>(null);

  async function load(force = false) {
    setLoading(true);
    try {
      const data = await listSessions(force);
      setSessions(data.sessions);
      setPlatforms(data.platforms);
    } catch (e) {
      flash(`读取失败：${friendly(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function refreshTrash() {
    try {
      setTrash(await trashList());
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    load(false);
    refreshTrash();
    // 首屏渲染完成后再空闲预加载 Markdown/KaTeX/highlight.js，避免阻塞窗口弹出
    const t = window.setTimeout(() => {
      import("./Markdown");
    }, 600);
    return () => window.clearTimeout(t);
  }, []);

  // 后台扫描完成后主进程会推送最新结果，替换掉启动时用的快照
  useEffect(() => {
    const off = window.api.onSessionsUpdated((data) => {
      setSessions(data.sessions);
      setPlatforms(data.platforms);
      setLoading(false);
    });
    return off;
  }, []);

  /** Electron IPC 抛出的错误带一长串前缀，去掉后只留人话 */
  function friendly(e: unknown) {
    return String((e as Error)?.message ?? e)
      .replace(/^Error invoking remote method '[^']+':\s*/, "")
      .replace(/^Error:\s*/, "");
  }

  function flash(msg: string) {
    setToast(msg);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast("");
    }, 3000);
  }

  // 主区与预览区之间的分隔条：拖动改宽度，双击复位，宽度记在本地
  useEffect(() => {
    const saved = Math.round(drawerWidth);
    if (saved >= 320) localStorage.setItem("drawerWidth", String(saved));
  }, [drawerWidth]);

  // 窗口变小时，预览区自动收窄，避免把主表格挤没
  useEffect(() => {
    const onResize = () =>
      setDrawerWidth((w) => Math.min(w, Math.max(320, window.innerWidth - 520)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /**
   * 主区与预览区之间的分隔条：借鉴 VS Code / JetBrains 的辅助线拖拽模式，
   * 拖拽过程中只用 GPU transform 移动 2px 指示线，零重排；松手时再一次性更新抽屉宽度。
   */
  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = drawerRef.current?.offsetWidth ?? drawerWidth;
    const minW = 320;
    const maxW = Math.max(360, window.innerWidth - 520);
    let nextWidth = startWidth;
    let raf = 0;

    const guide = guideRef.current;
    const initialLeft = window.innerWidth - startWidth;
    if (guide) {
      guide.style.display = "block";
      guide.style.transform = `translateX(${initialLeft}px)`;
    }

    const applyGuide = () => {
      raf = 0;
      if (guide) guide.style.transform = `translateX(${window.innerWidth - nextWidth}px)`;
    };

    const onMove = (ev: MouseEvent) => {
      nextWidth = Math.min(Math.max(startWidth + (startX - ev.clientX), minW), maxW);
      if (!raf) raf = window.requestAnimationFrame(applyGuide);
    };
    const onUp = () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      if (guide) guide.style.display = "none";
      setDrawerWidth(nextWidth);
    };

    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const keyOf = (s: Session) => `${s.platform}:${s.id}`;

  function togglePick(s: Session) {
    const k = keyOf(s);
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  function exitBatch() {
    setBatch(false);
    setPicked(new Set());
  }

  /** 索引只列用户发言：助手回复太碎，列出来会变成噪音 */
  const turns = useMemo(
    () =>
      messages
        .map((m, i) => ({ m, i }))
        .filter((x) => x.m.role === "user")
        .map((x, n) => ({
          no: n + 1,
          index: x.i,
          text: x.m.text
            .replace(/<\/?command-[a-z-]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        })),
    [messages]
  );

  /** 滚动到助手回复时仍保持对应那一轮的用户提问高亮 */
  const activeTurnIndex = useMemo(() => {
    if (turns.length === 0) return -1;
    if (activeIdx < 0) return turns[0].index;
    let matched = turns[0].index;
    for (const t of turns) {
      if (t.index <= activeIdx) matched = t.index;
      else break;
    }
    return matched;
  }, [turns, activeIdx]);

  const activeTurnNo = useMemo(
    () => turns.find((t) => t.index === activeTurnIndex)?.no ?? 1,
    [turns, activeTurnIndex]
  );

  function openMap() {
    if (mapCloseTimer.current !== null) {
      window.clearTimeout(mapCloseTimer.current);
      mapCloseTimer.current = null;
    }
    setMapOpen(true);
  }

  function closeMap() {
    if (mapCloseTimer.current !== null) window.clearTimeout(mapCloseTimer.current);
    mapCloseTimer.current = window.setTimeout(() => {
      mapCloseTimer.current = null;
      setMapOpen(false);
    }, 140);
  }

  useEffect(() => {
    return () => {
      if (mapCloseTimer.current !== null) window.clearTimeout(mapCloseTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!mapOpen || !tocListRef.current) return;
    const activeEl = tocListRef.current.querySelector(".toc-item.active") as HTMLElement | null;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [mapOpen, activeTurnIndex]);

  function jumpTo(index: number) {
    const body = bodyRef.current;
    if (!body) return;
    manualJumpUntil.current = Date.now() + 550;
    setActiveIdx(index);
    const el = body.querySelector(`[data-idx="${index}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 刻度轨按整数像素居中：半像素会让 2px 的刻度被抗锯齿糊成 3px */
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const gap = turns.length > 100 ? 2 : turns.length > 64 ? 4 : turns.length > 32 ? 6 : 12;
    const measure = () => {
      const content = turns.length * 2 + Math.max(0, turns.length - 1) * gap;
      setRailTop(Math.max(6, Math.round((el.clientHeight - content) / 2)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [turns.length, drawerWidth]);

  /** 滚动时高亮当前顶部的消息：rAF 节流 + 二分查找，长会话下避免全量 getBoundingClientRect */
  function onBodyScroll() {
    if (scrollRaf.current) return;
    scrollRaf.current = window.requestAnimationFrame(() => {
      scrollRaf.current = 0;
      if (Date.now() < manualJumpUntil.current) return;
      const body = bodyRef.current;
      if (!body) return;
      const nodes = body.querySelectorAll<HTMLElement>("[data-idx]");
      if (nodes.length === 0) return;

      // 已经滚到底部时，底部最后一条往往顶不到视口最上方，直接高亮最后一条
      if (body.scrollHeight > body.clientHeight && body.scrollTop + body.clientHeight >= body.scrollHeight - 4) {
        setActiveIdx(Number(nodes[nodes.length - 1].dataset.idx));
        return;
      }

      const top = body.getBoundingClientRect().top + 16;
      let lo = 0;
      let hi = nodes.length - 1;
      let current = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nodes[mid].getBoundingClientRect().top <= top) {
          current = Number(nodes[mid].dataset.idx);
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      setActiveIdx(current);
    });
  }



  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (platform !== "all" && s.platform !== platform) return false;
      if (archFilter === "archived" && !s.archived) return false;
      if (archFilter === "unarchived" && s.archived) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        (s.project ?? "").toLowerCase().includes(q) ||
        (s.cwd ?? "").toLowerCase().includes(q)
      );
    });
  }, [sessions, query, platform, archFilter]);

  async function open(s: Session) {
    setSelected(s);
    setMessages([]);
    setActiveIdx(-1);
    setMapOpen(false);
    setLoadingMsg(true);
    try {
      setMessages(await readSession(s.platform, s.id));
    } catch (e) {
      flash(`读取会话失败：${friendly(e)}`);
    } finally {
      setLoadingMsg(false);
    }
  }

  async function toggleArchive() {
    if (!selected) return;
    const target = selected;
    const archived = !target.archived;

    // 先动界面，再落盘；失败回滚，避免「点了没反应」
    setSelected({ ...target, archived });
    setSessions((prev) =>
      prev.map((x) =>
        x.platform === target.platform && x.id === target.id ? { ...x, archived } : x
      )
    );

    try {
      await archive(target.platform, target.id, archived);
      flash(archived ? "已归档" : "已取消归档");
    } catch (e) {
      setSelected(target);
      setSessions((prev) =>
        prev.map((x) =>
          x.platform === target.platform && x.id === target.id
            ? { ...x, archived: target.archived }
            : x
        )
      );
      flash(`操作失败：${friendly(e)}`);
    }
  }

  async function doDelete() {
    if (!selected) return;
    if (!selected.archived) {
      flash("只有已归档的会话才能删除");
      return;
    }
    const target = selected;
    setConfirmBox({
      title: "移入隔离区",
      body: `会话「${target.title}」将从 ${target.platform} 的原始数据中移除。\n系统会先完整备份，可随时在隔离区还原。`,
      confirmText: "移入隔离区",
      danger: true,
      exportOption: true,
      run: async () => {
        try {
          const res = await remove(target.platform, target.id, target, { exportFirst });
          setSelected(null);
          setSessions((prev) =>
            prev.filter((x) => !(x.platform === target.platform && x.id === target.id))
          );
          await refreshTrash();
          flash(res.exported ? `已导出并移入隔离区\n${res.exported.path}` : "已移入隔离区");
        } catch (e) {
          flash(`删除失败：${friendly(e)}`);
        }
      },
    });
  }

  async function copyMarkdown() {
    if (!selected) return;
    try {
      const md = await exportMarkdown(selected.platform, selected.id, selected.title);
      await navigator.clipboard.writeText(md);
      flash(`已复制 Markdown（${(md.length / 1024).toFixed(1)} KB）`);
    } catch (e) {
      flash(`导出失败：${friendly(e)}`);
    }
  }

  function saveMarkdown() {
    if (!selected) return;
    const target = selected;
    const safe = (target.title || "session").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    setPathPicker({
      mode: "save-file",
      defaultFileName: `${safe}_${target.platform}_${stamp}.md`,
      onConfirm: async (targetPath) => {
        try {
          const res = await exportFile(target.platform, target.id, target.title, targetPath);
          setPathPicker(null);
          flash(`已导出（${(res.bytes / 1024).toFixed(1)} KB）\n${res.path}`);
        } catch (e) {
          flash(`导出失败：${friendly(e)}`);
        }
      },
    });
  }

  const total = platforms.reduce((n, p) => n + p.count, 0);

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          SessionDock <span>本机 AI 会话统一管理</span>
        </div>
        <div style={{ flex: 1, height: "100%" }} />
        <button className="winbtn" onClick={() => window.api.win.minimize()} title="最小化">—</button>
        <button className="winbtn" onClick={() => window.api.win.toggleMaximize()} title="最大化">□</button>
        <button className="winbtn close" onClick={() => window.api.win.close()} title="关闭">✕</button>
      </div>

      <div className="body">
        <aside className="sidebar">
          <div className="side-title">平台</div>
          <div className={`platform ${platform === "all" ? "active" : ""}`} onClick={() => setPlatform("all")}>
            <span className="dot" style={{ background: "#c15f3c" }} />
            <span className="name">全部</span>
            <span className="count">{total}</span>
          </div>

          {platforms.map((p) => (
            <div
              key={p.platform}
              className={`platform ${platform === p.platform ? "active" : ""}`}
              onClick={() => setPlatform(p.platform)}
              style={{ opacity: p.count === 0 ? 0.45 : 1 }}
              title={p.error ? `读取异常：${p.error}` : undefined}
            >
              <span className="dot" style={{ background: PLATFORM_COLOR[p.platform] ?? "#a89e8e" }} />
              <span className="name">{p.label}</span>
              <span className="count">{p.count}</span>
            </div>
          ))}

          <div style={{ flex: 1 }} />
          <div className="platform" onClick={() => setShowTrash(true)}>
            <span className="dot" style={{ background: "#8a6a9e" }} />
            <span className="name">隔离区</span>
            <span className="count">{trash.length}</span>
          </div>
        </aside>

        <main className="main">
          <div className="toolbar">
            <input
              type="search"
              placeholder="搜索标题 / 项目 / 目录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="arch-filter"
              value={archFilter}
              onChange={(e) => setArchFilter(e.target.value as "all" | "unarchived" | "archived")}
              title="按归档状态筛选"
            >
              <option value="all">全部</option>
              <option value="unarchived">未归档</option>
              <option value="archived">已归档</option>
            </select>
            <button onClick={() => reveal("")} title="打开 Markdown 导出目录">导出目录</button>
            <button onClick={() => load(true)} disabled={loading}>
              {loading ? "读取中…" : "刷新"}
            </button>

            {!batch ? (
              <button onClick={() => setBatch(true)}>批量操作</button>
            ) : (
              <>
                <button
                  onClick={async () => {
                    if (picked.size === 0) return;
                    const items = sessions.filter((x) => picked.has(keyOf(x))).map((x) => ({ platform: x.platform, id: x.id }));
                    await archiveMany(items, true);
                    const keys = new Set(items.map((i) => `${i.platform}:${i.id}`));
                    setSessions((prev) =>
                      prev.map((x) => (keys.has(`${x.platform}:${x.id}`) ? { ...x, archived: true } : x))
                    );
                    flash(`已归档 ${items.length} 个会话`);
                    exitBatch();
                  }}
                >
                  归档
                </button>
                <button
                  onClick={() => {
                    if (picked.size === 0) return;
                    const items = sessions.filter((x) => picked.has(keyOf(x)));
                    setPathPicker({
                      mode: "pick-dir",
                      onConfirm: async (targetDir) => {
                        try {
                          const res = await exportMany(items, targetDir);
                          setPathPicker(null);
                          flash(`已导出 ${res.ok} 个${res.fail ? `，失败 ${res.fail} 个` : ""}\n${res.dir}`);
                        } catch (e) {
                          flash(`导出失败：${friendly(e)}`);
                        }
                      },
                    });
                  }}
                >
                  导出
                </button>
                <button
                  className="danger-outline"
                  onClick={() => {
                    const items = sessions.filter((x) => picked.has(keyOf(x)));
                    const deletable = items.filter((x) => x.archived);
                    if (deletable.length === 0) {
                      flash("所选会话中没有已归档的，无法删除");
                      return;
                    }
                    setConfirmBox({
                      title: "批量移入隔离区",
                      body: `已选择 ${items.length} 个会话，其中 ${deletable.length} 个已归档将被删除，${items.length - deletable.length} 个未归档会跳过。\n所有被删除的会话会先备份到隔离区。`,
                      confirmText: `删除 ${deletable.length} 个`,
                      danger: true,
                      exportOption: true,
                      run: async () => {
                        const res = await removeMany(items, { exportFirst });
                        const gone = new Set(
                          items.filter((x) => x.archived).map((x) => `${x.platform}:${x.id}`)
                        );
                        setSessions((prev) => prev.filter((x) => !gone.has(`${x.platform}:${x.id}`)));
                        await refreshTrash();
                        const extra = res.errors.length ? `\n失败 ${res.errors.length} 个：${res.errors[0]}` : "";
                        flash(`已删除 ${res.deleted} 个，跳过 ${res.skipped} 个${res.exported ? `，导出 ${res.exported} 个` : ""}${extra}`);
                        exitBatch();
                      },
                    });
                  }}
                >
                  删除
                </button>
                <button onClick={exitBatch}>退出批量</button>
                <span className="hint">已选 {picked.size}</span>
              </>
            )}

            <div className="spacer" />
            <span className="hint">显示 {filtered.length} / {sessions.length}</span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {batch && (
                    <th className="row-check">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && filtered.every((x) => picked.has(keyOf(x)))}
                        onChange={(e) => {
                          const next = new Set(picked);
                          for (const x of filtered) {
                            e.target.checked ? next.add(keyOf(x)) : next.delete(keyOf(x));
                          }
                          setPicked(next);
                        }}
                      />
                    </th>
                  )}
                  <th style={{ width: "42%" }}>标题</th>
                  <th style={{ width: 96 }}>平台</th>
                  <th>项目</th>
                  <th style={{ width: 56 }}>消息</th>
                  <th style={{ width: 128 }}>更新时间</th>
                  <th style={{ width: 72 }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const active = selected?.id === s.id && selected?.platform === s.platform;
                  const label = platforms.find((p) => p.platform === s.platform)?.label ?? s.platform;
                  return (
                    <tr
                      key={`${s.platform}:${s.id}`}
                      className={active ? "sel" : ""}
                      onClick={() => (batch ? togglePick(s) : open(s))}
                      style={{ opacity: s.archived ? 0.6 : 1 }}
                    >
                      {batch && (
                        <td className="row-check">
                          <input
                            type="checkbox"
                            checked={picked.has(keyOf(s))}
                            onChange={() => togglePick(s)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                      )}
                      <td className="t" title={s.title}>{s.title}</td>
                      <td>
                        <span className="badge" style={{ color: PLATFORM_COLOR[s.platform] ?? "#a89e8e" }}>
                          {label}
                        </span>
                      </td>
                      <td className="mono">{s.project ?? "—"}</td>
                      <td className="mono">{s.messageCount}</td>
                      <td className="mono">{fmtTime(s.updatedAt)}</td>
                      <td className="mono">{s.archived ? "已归档" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && filtered.length === 0 && <div className="empty">没有匹配的会话</div>}
          </div>
        </main>

        {selected && (
          <>
            <div
              className="splitter"
              onMouseDown={startResize}
              onDoubleClick={() => setDrawerWidth(460)}
              title="拖动调整宽度，双击复位"
            />
            <aside className="drawer" ref={drawerRef} style={{ width: drawerWidth }}>
            <div className="drawer-head">
              <div className="drawer-top">
                <h3>{selected.title}</h3>
                <button className="icon-btn" onClick={() => setSelected(null)} title="关闭预览">✕</button>
              </div>
              <div className="mono">{selected.cwd ?? selected.path}</div>
              <div className="drawer-actions">
                <button onClick={toggleArchive}>{selected.archived ? "取消归档" : "归档"}</button>
                <button onClick={copyMarkdown}>复制 MD</button>
                <button onClick={saveMarkdown}>保存 .md</button>
                <button
                  onClick={doDelete}
                  disabled={!selected.archived}
                  title={selected.archived ? "移入隔离区" : "仅限已归档的会话"}
                  style={{ borderColor: selected.archived ? "#d13438" : undefined }}
                >
                  删除
                </button>
              </div>
            </div>
            <div className="drawer-content">
              <div
                className="drawer-body"
                ref={bodyRef}
                onScroll={onBodyScroll}
              >
                {loadingMsg && <div className="empty">读取中…</div>}
                {!loadingMsg && messages.length === 0 && <div className="empty">没有可显示的消息</div>}
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role}`} data-idx={i} id={`msg-${i}`}>
                    <div className="who">
                      <span className="who-label">
                        {m.role === "user" ? "用户" : m.role === "system" ? "系统" : "助手"}
                      </span>
                      {m.timestamp ? <span className="who-time">{fmtTime(m.timestamp)}</span> : null}
                    </div>
                    <div className="msg-body">
                      <Suspense fallback={<div className="md" style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>}>
                        <Markdown text={m.text} />
                      </Suspense>
                    </div>
                  </div>
                ))}
              </div>

              {turns.length > 0 && (
                <>
                  <div
                    className={`map-rail ${mapOpen ? "hidden" : ""}`}
                    ref={mapRef}
                    onMouseEnter={openMap}
                    onMouseLeave={closeMap}
                  >
                    <div
                      className="map-rail-inner"
                      style={{
                        gap: turns.length > 100 ? 2 : turns.length > 64 ? 4 : turns.length > 32 ? 6 : 12,
                        top: railTop ?? undefined,
                      }}
                    >
                      {turns.map((t) => (
                        <div
                          key={t.index}
                          className={`tick ${activeTurnIndex === t.index ? "on" : ""}`}
                          onClick={() => jumpTo(t.index)}
                          title={`${t.no}. ${t.text.slice(0, 80)}`}
                        />
                      ))}
                    </div>
                  </div>

                  <div
                    className={`map-card ${mapOpen ? "open" : ""}`}
                    onMouseEnter={openMap}
                    onMouseLeave={closeMap}
                  >
                    <div className="toc-head">
                      <span>对话索引</span>
                      <span className="toc-badge">{activeTurnNo} / {turns.length}</span>
                    </div>
                    <div className="toc-list" ref={tocListRef}>
                      {turns.map((t) => (
                        <div
                          key={t.index}
                          className={`toc-item ${activeTurnIndex === t.index ? "active" : ""}`}
                          onClick={() => jumpTo(t.index)}
                          title={t.text}
                        >
                          <span className="toc-no">{t.no}</span>
                          <span className="toc-text">{t.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            </aside>
          </>
        )}
      </div>

      {showTrash && (
        <div className="overlay" onClick={() => setShowTrash(false)}>
          <div className="modal trash" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>隔离区</b>
              <span className="hint">已删除的会话会先备份到这里</span>
              <div style={{ flex: 1 }} />
              <button
                className="danger-outline"
                disabled={trash.length === 0}
                onClick={() =>
                  setConfirmBox({
                    title: "清空隔离区",
                    body: `隔离区共 ${trash.length} 项备份。\n清空后这些备份将被永久删除，无法还原。`,
                    confirmText: `永久删除 ${trash.length} 项`,
                    danger: true,
                    run: async () => {
                      const res = await trashPurgeAll();
                      await refreshTrash();
                      flash(
                        `已清空 ${res.count} 项，释放 ${(res.bytes / 1048576).toFixed(1)} MB`
                      );
                    },
                  })
                }
              >
                一键清空
              </button>
              <button onClick={() => setShowTrash(false)}>关闭</button>
            </div>
            <div className="trash-list">
              {trash.length === 0 && <div className="empty">隔离区是空的</div>}
              {trash.map((t) => (
                <div key={t.trashId} className="trash-row">
                  <span className="mono" style={{ width: 90 }}>{t.platform}</span>
                  <span className="trash-title">{t.title}</span>
                  <span className="mono">{fmtTime(t.deletedAt)}</span>
                  <button
                    onClick={async () => {
                      try {
                        await trashRestore(t.trashId);
                        await load(true);
                        await refreshTrash();
                        flash("已还原");
                      } catch (e) {
                        flash(`还原失败：${friendly(e)}`);
                      }
                    }}
                  >
                    还原
                  </button>
                  <button
                    onClick={() => {
                      setConfirmBox({
                        title: "彻底删除",
                        body: `「${t.title}」将永久删除，无法恢复。\n这一步不可撤销。`,
                        confirmText: "永久删除",
                        danger: true,
                        run: async () => {
                          await trashPurge(t.trashId);
                          await refreshTrash();
                          flash("已彻底删除");
                        },
                      });
                    }}
                    style={{ borderColor: "#d13438" }}
                  >
                    彻底删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmBox && (
        <div className="overlay" onClick={() => setConfirmBox(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{confirmBox.title}</div>
            <div className="modal-body">{confirmBox.body}</div>
            {confirmBox.exportOption && (
              <label className="modal-check">
                <input
                  type="checkbox"
                  checked={exportFirst}
                  onChange={(e) => setExportFirst(e.target.checked)}
                />
                删除前先导出 Markdown 备份
              </label>
            )}
            <div className="modal-actions">
              <button onClick={() => setConfirmBox(null)}>取消</button>
              <button
                className={confirmBox.danger ? "danger" : "primary"}
                onClick={async () => {
                  const run = confirmBox.run;
                  setConfirmBox(null);
                  await run();
                }}
              >
                {confirmBox.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {pathPicker && (
        <PathPickerModal
          mode={pathPicker.mode}
          defaultFileName={pathPicker.defaultFileName}
          onCancel={() => setPathPicker(null)}
          onConfirm={pathPicker.onConfirm}
        />
      )}

      {toast && (
        <div className="toast">{toast}</div>
      )}

      <div className="splitter-guide" ref={guideRef} style={{ display: "none" }} />
    </div>
  );
}
