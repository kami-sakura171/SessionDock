const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const cssFile = fs.readdirSync(path.join(ROOT, "dist", "assets")).find((f) => f.endsWith(".css"));
const css = fs.readFileSync(path.join(ROOT, "dist", "assets", cssFile), "utf8");

const ticks = Array.from({ length: 10 }).map((_, i) => `<div class="tick ${i === 5 ? "on" : ""}"></div>`).join("");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
body{background:#f7f4ee;margin:0;padding:14px;font-family:"Segoe UI"}
</style></head><body>
<div class="drawer" style="width:740px;height:230px">
  <div class="drawer-head">
    <div class="drawer-top"><h3>解释黎曼猜想与素数分布的关系</h3><button class="icon-btn">✕</button></div>
    <div class="mono">D://LLM//math-notes</div>
    <div class="drawer-actions"><button>归档</button><button>复制 MD</button><button>保存 .md</button><button class="danger-outline">删除</button></div>
  </div>
  <div class="drawer-body"><div class="msg assistant"><div class="who">助手</div><div class="md"><p>临界线上的零点分布决定了素数计数的误差项。</p></div></div></div>
  <div class="map"><div class="map-rail" style="gap:12px;top:20px">${ticks}</div></div>
</div></body></html>`;
fs.writeFileSync(path.join(ROOT, ".head-preview.html"), html, "utf8");
console.log("ok");
