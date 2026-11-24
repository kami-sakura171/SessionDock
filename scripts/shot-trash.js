const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const cssFile = fs.readdirSync(path.join(ROOT, "dist", "assets")).find((f) => f.endsWith(".css"));
const css = fs.readFileSync(path.join(ROOT, "dist", "assets", cssFile), "utf8");

const rows = [
  ["claude", "解释黎曼猜想与素数分布的关系", "2026-11-23 18:42"],
  ["cursor", "WB API payload limit issue", "2026-11-23 17:10"],
  ["codex", "统计稿件残留问题", "2026-11-23 16:35"],
  ["antigravity", "@[paper_cscwd2027.tex] 检查英文稿", "2026-11-23 15:20"],
]
  .map(
    ([p, t, d]) => `<div class="trash-row">
    <span class="mono" style="width:90px">${p}</span>
    <span class="trash-title">${t}</span>
    <span class="mono">${d}</span>
    <button>还原</button><button class="danger-outline">彻底删除</button>
  </div>`
  )
  .join("");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
body{background:#f7f4ee;margin:0;font-family:"Segoe UI"}
</style></head><body>
<div class="overlay" style="position:static;padding:24px">
  <div class="modal trash">
    <div class="modal-head">
      <b>隔离区</b><span class="hint">已删除的会话会先备份到这里</span>
      <div style="flex:1"></div>
      <button class="danger-outline">一键清空</button>
      <button>关闭</button>
    </div>
    <div class="trash-list">${rows}</div>
  </div>
</div></body></html>`;
fs.writeFileSync(path.join(ROOT, ".trash-preview.html"), html, "utf8");
console.log("ok");
