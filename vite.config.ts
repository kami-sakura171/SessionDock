import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 需要固定端口，且不能在端口被占用时静默换端口
export default defineConfig({
  // 打包后用 file:// 加载，必须用相对路径，否则 /assets 会解析到盘符根目录
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome130",
    minify: "esbuild",
    sourcemap: false,
    // 不让 Vite 构建时整体 rm -rf dist：本机有批量删除保护会拦截；
    // 旧产物用 scripts/clean-dist.cjs 逐文件清理
    emptyOutDir: false,
  },
});
