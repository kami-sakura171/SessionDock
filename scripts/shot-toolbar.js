const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const cssFile = fs.readdirSync(path.join(ROOT, "dist", "assets")).find((f) => f.endsWith(".css"));
const css = fs.readFileSync(path.join(ROOT, "dist", "assets", cssFile), "utf8");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:#f7f4ee;font-family:"Segoe UI"}
</style></head><body>
<div class="main" style="height:120px">
  <div class="toolbar">
    <input type="search" placeholder="搜索标题 / 项目 / 目录" />
    <select class="arch-filter" title="按归档状态筛选">
      <option>全部</option><option>未归档</option><option>已归档</option>
    </select>
    <button>导出目录</button>
    <button>刷新</button>
    <button>批量操作</button>
    <div class="spacer"></div>
    <span class="hint">显示 175 / 175</span>
  </div>
</div></body></html>`;
fs.writeFileSync(path.join(ROOT, ".toolbar-preview.html"), html, "utf8");
console.log("ok");
