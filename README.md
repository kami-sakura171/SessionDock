# SessionDock

**Unified local session manager for AI coding agents.**  
**本机 AI 编程助手会话统一管理桌面应用。**

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

**SessionDock** is an Electron + React + TypeScript desktop application for browsing, searching, exporting, archiving, and safely deleting local chat sessions across multiple AI coding agents.

### Supported Platforms

| Platform | Local Data Source |
| :--- | :--- |
| **Codex** | `~/.codex` (`state_*.sqlite`, `thread_history_*.sqlite`, `rollout-*.jsonl`) |
| **Claude Code** | `~/.claude/projects` (`*.jsonl`) |
| **Cursor** | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| **Antigravity** | `~/.gemini/antigravity/brain` (`transcript/*.jsonl`) |
| **Hermes** | `%LOCALAPPDATA%/hermes/state.db` |
| **Pi** | `~/.pi/agent/sessions` (`*.jsonl`) |
| **VS Code** | `%APPDATA%/Code/User/workspaceStorage/*/chatSessions` |
| **Kiro** | `%APPDATA%/Kiro/User/globalStorage/kiro.kiroagent` |

### Key Features

- **Unified Session Browser**: Aggregate sessions from 8 AI coding agents in one view, filter by platform or archive status, and search by title, project, or working directory.
- **Rich Conversation Preview**:
  - Right-aligned user bubbles and left-aligned full-width assistant responses.
  - Markdown rendering with `highlight.js` code syntax highlighting, one-click code copy, and `KaTeX` math formulas.
  - Floating turn index card & right-side minimap rail for quick navigation in long conversations.
- **Markdown Export**: Copy Markdown directly or export single/batch sessions using the built-in themed file & folder picker.
- **Safe Archive & Quarantine Deletion**:
  - Enforces **archive-before-delete** to prevent accidental loss.
  - Deleted sessions are backed up to a local Quarantine (`%APPDATA%/session-dock/trash`) before removal from the original database/files, supporting one-click restore or permanent purge.
  - Checks running agent processes before modifying SQLite databases to avoid lock conflicts or corruption.
- **Fast Startup & Smooth UI**: Uses disk snapshot caching + background `worker_threads` scanning, lazy-loaded Markdown/KaTeX chunks, `content-visibility: auto`, and GPU-composited splitter guide dragging.

### Download

Pre-built Windows installers are available on the [Releases](https://github.com/kami-sakura171/SessionDock/releases) page.

### Development & Build

```bash
npm install
npm run dev      # Start Vite dev server & Electron
npm run build    # Type-check & build frontend assets
npm run dist     # Build Windows NSIS installer into release/
```

---

<a id="中文"></a>

## 中文

**SessionDock** 是一款基于 Electron + React + TypeScript 构建的桌面端工具，用于统一浏览、搜索、导出、归档以及安全清理本机多个 AI 编程助手的本地对话记录。

### 支持平台

| 平台 | 本地数据来源 |
| :--- | :--- |
| **Codex** | `~/.codex`（`state_*.sqlite`、`thread_history_*.sqlite`、`rollout-*.jsonl`） |
| **Claude Code** | `~/.claude/projects`（`*.jsonl`） |
| **Cursor** | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| **Antigravity** | `~/.gemini/antigravity/brain`（`transcript/*.jsonl`） |
| **Hermes** | `%LOCALAPPDATA%/hermes/state.db` |
| **Pi** | `~/.pi/agent/sessions`（`*.jsonl`） |
| **VS Code** | `%APPDATA%/Code/User/workspaceStorage/*/chatSessions` |
| **Kiro** | `%APPDATA%/Kiro/User/globalStorage/kiro.kiroagent` |

### 核心功能

- **多平台会话聚合**：统一汇总 8 个 AI 编程助手的本地会话，支持按平台、归档状态筛选，以及按标题、项目名、工作目录关键词搜索。
- **沉浸式预览阅读**：
  - 用户消息靠右气泡展示，助手回答靠左全宽排布。
  - 支持 Markdown 渲染、`highlight.js` 代码高亮与一键复制、`KaTeX` 数学公式。
  - 右侧常驻刻度轨与悬浮「对话索引」卡片，长会话中快速定位与跳转。
- **Markdown 导出**：支持一键复制 Markdown，或通过自绘统一样式的路径选择弹窗进行单条导出与批量导出。
- **归档与隔离区安全删除**：
  - 遵循「仅已归档会话可删除」规则，防止误删重要对话。
  - 删除前先完整备份至本地隔离区（`%APPDATA%/session-dock/trash`），支持随时一键还原或彻底清空。
  - 操作平台 SQLite 数据库前自动检测对应客户端进程是否占用，避免写坏原始库。
- **流畅性能体验**：启动快照秒开 + 后台 `worker_threads` 扫描、Markdown/KaTeX 按需懒加载、`content-visibility: auto` 渲染优化及辅助线 GPU 拖拽。

### 下载安装

可在 [Releases](https://github.com/kami-sakura171/SessionDock/releases) 页面下载最新 Windows 安装包。

### 本地开发与打包

```bash
npm install
npm run dev      # 启动 Vite 开发服务器与 Electron
npm run build    # TypeScript 类型检查与前端构建
npm run dist     # 打包 Windows NSIS 安装包至 release/
```
