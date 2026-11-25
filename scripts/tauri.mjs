/**
 * 统一的 Tauri CLI 入口：在这里固定 GNU 工具链与 E 盘缓存目录，
 * 这样 `npm run dev` / `npm run dist` 不需要用户手工配环境变量。
 *
 * 约束（见 MIGRATION_PLAN.md 第 1 节）：
 *   - 不装 Visual Studio C++ Build Tools，只用 Rust GNU 工具链 + D:\mingw64 的 gcc
 *   - 工具链 / Cargo 缓存 / 编译产物全部落在 E 盘
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEV_TOOLS = process.env.SESSIONDOCK_DEVTOOLS || "E:\\DevTools";
const MINGW_BIN = process.env.SESSIONDOCK_MINGW_BIN || "D:\\mingw64\\bin";const dirs = {
  cargo: path.join(DEV_TOOLS, "cargo"),
  rustup: path.join(DEV_TOOLS, "rustup"),
  target: path.join(DEV_TOOLS, "target"),
  bundlerTools: path.join(DEV_TOOLS, "tauri-tools"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const TOOLCHAIN = "stable-x86_64-pc-windows-gnu";
// rustc 生成 raw-dylib 导入库时要调 dlltool.exe（在 PATH 里找）。
// 单独给它一个只含 binutils 的目录，避免把 D:\mingw64\bin 的老 DLL 暴露给新编译的程序。
const binutils = path.join(DEV_TOOLS, "mingw-tools", "bin");
mkdirSync(binutils, { recursive: true });
// dlltool 生成导入库时还要调 as.exe，binutils 必须成套；只拷 exe，不拷老运行库 DLL
for (const tool of ["as.exe", "dlltool.exe", "ld.exe", "ar.exe", "nm.exe", "ranlib.exe", "objcopy.exe", "strip.exe", "windres.exe"]) {
  const dst = path.join(binutils, tool);
  const src = path.join(MINGW_BIN, tool);
  if (!existsSync(dst) && existsSync(src)) copyFileSync(src, dst);
}

// rustup 的代理程序仍在 %USERPROFILE%\.cargo\bin，工具链本体在 E 盘
const rustupShim = path.join(process.env.USERPROFILE || "", ".cargo", "bin");
const env = {
  ...process.env,
  CARGO_HOME: dirs.cargo,
  RUSTUP_HOME: dirs.rustup,
  CARGO_TARGET_DIR: dirs.target,
  RUSTUP_TOOLCHAIN: TOOLCHAIN,
  // NSIS 等打包工具也放到 E 盘，避免写 %LOCALAPPDATA%
  TAURI_BUNDLER_TOOLS_PATH: dirs.bundlerTools,
  // windres 需要 gcc 做预处理，dlltool 需要 as，所以 MinGW 必须在 PATH 上；
  // 但 rustc 的链接器已在 .cargo/config.toml 里钉死为 Rust 自包含链接器，
  // 不会被这里的老 gcc 带偏（否则产物会引用本机不存在的 DLL 入口点）。
  CC_x86_64_pc_windows_gnu: path.join(MINGW_BIN, "gcc.exe"),
  CXX_x86_64_pc_windows_gnu: path.join(MINGW_BIN, "g++.exe"),
  AR_x86_64_pc_windows_gnu: path.join(MINGW_BIN, "ar.exe"),
  // MinGW 8.1 默认的 _WIN32_WINNT 太低，sqlite3.c 里 GetTickCount64 不会声明
  CFLAGS_x86_64_pc_windows_gnu: "-D_WIN32_WINNT=0x0601 -DWINVER=0x0601",
  PATH: [binutils, MINGW_BIN, rustupShim, process.env.PATH || ""].join(";"),
};

if (!existsSync(path.join(dirs.rustup, "toolchains"))) {
  console.error(
    "[sessiondock] 还没安装 GNU 工具链，请先执行：\n" +
      `  set RUSTUP_HOME=${dirs.rustup}\n` +
      `  set CARGO_HOME=${dirs.cargo}\n` +
      "  rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal --component rust-mingw",
  );
}

const cli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
