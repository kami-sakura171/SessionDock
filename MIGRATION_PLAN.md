# SessionDock Tauri + Rust 迁移执行方案

> 源项目：`E:\chat session manager`（Electron + React + TypeScript）  
> 目标项目：`E:\SessionDock-Tauri`（Tauri 2 + Rust 后端 + 复用现有 React 前端）

---

## 1. 环境与工具链约束（必读）

1. **禁止安装 Visual Studio C++ Build Tools**，禁止向 C 盘写入大型工具链/缓存。
2. **使用 Rust GNU 工具链 + 现有 MinGW**：
   - 本地已安装 `rustc` / `cargo` 与 `D:\mingw64\bin\gcc.exe`（MinGW-W64 GCC 8.1.0）。
   - 所有新增工具链、Cargo 缓存与编译产物目录统一放到 **E 盘新目录**（例如 `E:\DevTools\cargo`、`E:\DevTools\rustup`、`E:\DevTools\target`），`PATH` 追加 `D:\mingw64\bin`。
   - 安装 GNU 工具链：`rustup toolchain install stable-x86_64-pc-windows-gnu` 并设为默认或通过 `rustup target add x86_64-pc-windows-gnu` 编译。
3. **第 0 步先做最小编译验证**：
   - 初始化最小 Tauri 2 + `rusqlite`（`features = ["bundled"]`）项目，确认在 `D:\mingw64` + `x86_64-pc-windows-gnu` 下能顺利完成 `cargo check` / `cargo build`，再开始业务迁移。

---

## 2. 目录结构规划

```text
E:\SessionDock-Tauri\
├── src\                  # 从 E:\chat session manager\src 复制并微调 api.ts
├── index.html            # 复用
├── package.json          # 保留前端依赖，将 electron 相关替换为 @tauri-apps/cli & @tauri-apps/api
├── tsconfig.json         # 复用
├── vite.config.ts        # 复用（port: 1420, strictPort: true）
└── src-tauri\
    ├── Cargo.toml
    ├── tauri.conf.json   # productName: "SessionDock", identifier: "com.yan.sessiondock", 无边框窗口
    ├── capabilities\     # Tauri 2 权限配置（core:default, core:window:allow-* 等）
    ├── icons\            # 从 E:\chat session manager\assets\icon.png 生成
    └── src\
        ├── main.rs / lib.rs
        ├── store.rs      # 元数据、归档标记、隔离区索引、快照与索引缓存
        ├── delete.rs     # 安全删除、进程占用检测、隔离区备份与还原
        ├── commands.rs   # Tauri IPC 命令导出
        └── sessions\
            ├── mod.rs    # 平台注册表、并发扫描、Markdown 导出
            ├── codex.rs
            ├── claude.rs
            ├── cursor.rs
            ├── antigravity.rs
            ├── hermes.rs
            ├── pi.rs
            ├── vscode.rs
            └── kiro.rs
```

---

## 3. 前端迁移要求（`src/`）

1. **完整保留现有 UI 与交互优化**（直接从 `E:\chat session manager\src\` 复制）：
   - `App.tsx`：无边框自绘标题栏、左右对话气泡（用户靠右、助手靠左）、辅助线 GPU 拖拽（`.splitter-guide`）、索引悬浮卡片中线对齐与触底高亮修复、`rAF + 二分查找` 滚动监听。
   - `Markdown.tsx`：`React.lazy` 懒加载、20,000 字符截断保护、中文 `**粗体**` 扩展、KaTeX 提取保护 + DOMPurify 净化、代码块复制。
   - `PathPickerModal.tsx`：自绘统一样式路径/文件夹选择弹窗（替代系统原生弹窗）。
   - `styles.css`：`content-visibility: auto`、`table-layout: fixed`、窄窗口防溢出规则。
2. **仅修改通信适配层（`src/api.ts`）**：
   - 将 `window.api.*` 替换为 `@tauri-apps/api/core` 的 `invoke(...)`。
   - 将 `onSessionsUpdated` 替换为 `@tauri-apps/api/event` 的 `listen("sessions:updated", ...)`。
   - 将窗口最小化/最大化/关闭替换为 `@tauri-apps/api/window` 的 `getCurrentWindow()`。
   - 保持所有导出函数签名与 TypeScript 类型（`Session`、`Message`、`PlatformInfo`、`TrashItem`、`DirItem`、`DirListing`）不变，确保 `App.tsx` / `PathPickerModal.tsx` 几乎零改动。

---

## 4. Rust 后端实现规范（`src-tauri/src/`）

### 4.1 数据目录与快照（`store.rs`）
- 数据根目录：`%APPDATA%\session-dock`（与原版完全一致，实现无缝兼容）。
- 首次启动自动迁移检查：若 `%APPDATA%\chat-session-manager` 存在且 `%APPDATA%\session-dock\meta.json` 不存在，自动迁移 `meta.json`、`trash/`、`exports/`、`cursor-titles.json`、`pi-index.json`、`sessions-cache.json`，并重写 `meta.json` 中 `trash[].dir` 路径前缀。
- 快照机制：启动时先读取 `sessions-cache.json` 秒开列表，同时在后台线程执行扫描，扫描完成后写入 `sessions-cache.json` 并通过 `app.emit("sessions:updated", data)` 推送给前端。

### 4.2 8 个平台适配器（`sessions/*.rs`）
建议使用 `rayon` 并发扫描各平台，必须对齐原版所有边界逻辑：
1. **Codex（`codex.rs`）**：
   - 读取 `%USERPROFILE%\.codex`（或 `CODEX_HOME`）下版本号最大的 `state_*.sqlite` 和 `thread_history_*.sqlite`。
   - **过滤内部子代理**：排除 `thread_source = 'guardian_review'` 和 `source LIKE '{"subagent":%'`。
   - **项目名补全**：优先 `projects.name`，为空时回退 `basename(cwd)`。
   - **时间与消息完整同步**：统一秒/毫秒/ISO 时间戳转毫秒；`read(id)` 同时检查 `thread_history` 与 `rollout_path` JSONL（以及 `sessions/`、`archived_sessions/` 按 ID 兜底），消息数更多时以 rollout 为准；`list()` 通过 `codex-rollout-index.json` 按 `mtime` 缓存 rollout 消息数与最后时间。
   - **内部标签清理**：过滤 `<environment_context>`、`<codex_internal_context>` 等系统上下文块，压缩 `# Files mentioned by the user:` 附件块。
   - **锁冲突处理**：只读打开失败时复制 `.sqlite` + `-wal` + `-shm` 到临时目录读取，并在 `finally`/Drop 中删除临时目录。
2. **Claude Code（`claude.rs`）**：扫描 `~/.claude/projects`（深度 <= 2）的 `.jsonl`，提取 `ai-title`、`cwd`、`user`/`assistant` 文本与时间戳，跳过 `<local-command`。
3. **Cursor（`cursor.rs`）**：只读打开 `%APPDATA%\Cursor\User\globalStorage\state.vscdb`（2GB 大库**禁止复制**），用 `cursor-titles.json` 缓存首条标题，关联 `workspaceStorage/*/workspace.json` 获取项目名，`read()` 按气泡时间戳排序，务必及时关闭数据库连接。
4. **Antigravity（`antigravity.rs`）**：扫描 `~/.gemini/antigravity/brain/<id>/transcript/*.jsonl`，解析 `USER_INPUT` / `PLANNER_RESPONSE`，剥离 `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` / `<SYSTEM_MESSAGE>`。
5. **Hermes（`hermes.rs`）**：读取 `%LOCALAPPDATA%\hermes\state.db`（被占用时复制临时副本并在用完后清理），过滤 `hidden = 0`、`active = 1`、`compacted = 0`，秒级时间戳转毫秒。
6. **Pi（`pi.rs`）**：扫描 `~/.pi/agent/sessions/**/*.jsonl`，使用 `pi-index.json` 按 `mtime` 缓存元数据。
7. **VS Code（`vscode.rs`）**：扫描 `%APPDATA%\Code\User\workspaceStorage\*\chatSessions\*.json`。
8. **Kiro（`kiro.rs`）**：扫描 `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent` 下 `.json` / `.jsonl`。

### 4.3 安全删除与隔离区（`delete.rs`）
- 强制校验：**仅允许删除已归档的会话**。
- 进程占用检查：修改 Codex（`ChatGPT.exe`、`codex.exe`）、Cursor（`Cursor.exe`）等数据库前检测对应进程是否运行，运行中则拒绝并给出明确中文提示。
- 备份与还原：删除前先将数据库行（`BLOB` 字段用 base64 编码）或原始文件完整备份到 `%APPDATA%\session-dock\trash\<timestamp>_<platform>_<id前缀>\`，支持单条还原、单条彻底删除与一键清空（统计释放字节数）。

### 4.4 Tauri IPC 命令清单（`commands.rs`）
需与前端 `src/api.ts` 一一对应：
- `sessions_list(force)` / `sessions_read` / `sessions_export`
- `sessions_archive` / `sessions_archive_many`
- `sessions_export_many` / `sessions_delete` / `sessions_delete_many`
- `trash_list` / `trash_restore` / `trash_purge` / `trash_purge_all`
- `file_export` / `file_reveal`（调用系统资源管理器定位文件或目录）
- `fs_list_dir`（返回子目录、`.md` 文件、快捷位置、盘符列表；路径不存在时明确报错） / `fs_mkdir`

---

## 5. 验收标准（供最终审核）

1. **构建验证**：在 `x86_64-pc-windows-gnu` 下 `npm run tauri build` 零错误通过，产出 NSIS 安装包且体积明显小于 Electron 版（预期 `< 15 MB`）。
2. **数据一致性**：与 `E:\chat session manager` 对比 8 个平台扫描出的会话数、Codex 消息数与时间戳、`Guardian review` 过滤结果一致。
3. **核心功能回归**：
   - 无边框窗口拖拽/最小化/最大化/关闭正常，预览区链接由系统浏览器打开。
   - 自绘路径选择窗（单条保存 + 批量导出 + 新建文件夹）正常。
   - 归档 -> 删除至隔离区 -> 从隔离区还原完整闭环可用。
