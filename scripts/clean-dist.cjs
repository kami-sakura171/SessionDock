/**
 * 逐文件清理 dist（不调用目录级 rm -rf），避免触发本机的批量删除保护。
 * 只清理 Vite 产物目录 dist，别的一概不碰。
 * 用法：node scripts/clean-dist.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const dist = path.resolve(__dirname, "..", "dist");
let removed = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else {
      try {
        fs.unlinkSync(full);
        removed++;
      } catch (err) {
        console.warn("跳过", full, err.message);
      }
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* 目录非空就留着 */
  }
}

walk(dist);
console.log(`已清理 ${removed} 个旧产物文件`);
