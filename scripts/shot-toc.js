const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const cssFile = fs.readdirSync(path.join(ROOT, "dist", "assets")).find((f) => f.endsWith(".css"));
const css = fs.readFileSync(path.join(ROOT, "dist", "assets", cssFile), "utf8");

const items = [
  "把预览窗口的字体调大一点，现在看着有点小",
  "为什么标题和智能体里显示的不一样？",
  "增加批量操作，归档 / 导出 / 删除",
  "隔离区添加一键清空",
  "改成 claude 那样的陶土橙配色",
  "数学公式要用 TeX 渲染，不要显示源码",
  "这个索引 map 能不能也放到预览窗口里",
];

// 左侧：常驻刻度轨；右侧：悬停展开后的列表
const ticks = items.map((_, i) => `<div class="tick ${i === 2 ? "on" : ""}"></div>`).join("");
const rows = items
  .map((t, i) => `<div class="toc-item ${i === 2 ? "active" : ""}"><span class="toc-no">${i + 1}</span><span class="toc-text">${t}</span></div>`)
  .join("");

const body = `<div class="drawer-body" style="padding-right:44px">
  <div class="msg user"><div class="who">用户</div><div class="md"><p>黎曼猜想是什么？它和素数分布有什么关系？</p></div></div>
  <div class="msg assistant"><div class="who">助手</div><div class="md"><p>黎曼ζ函数的非平凡零点都在临界线上，这一结论直接决定了素数计数的误差项。</p></div></div>
</div>`;

const shell = (inner) => `<div class="drawer" style="width:780px;height:500px;display:block;margin-bottom:20px">
  <div class="drawer-head" style="height:86px">
    <div class="drawer-top"><h3>解释黎曼猜想</h3></div>
    <div class="mono">D:\LLM\math-notes</div>
    <div class="drawer-actions"><button>归档</button><button>复制 MD</button><button>保存 .md</button><button>删除</button></div>
  </div>
  ${body}
  ${inner}
</div>`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
body{background:#f7f4ee;margin:0;padding:16px;font-family:"Segoe UI"}
</style></head><body>
${shell(`<div class="map"><div class="map-rail" style="gap:5px">${ticks}</div></div>`)}
${shell(`<div class="map open"><div class="map-rail" style="gap:5px">${ticks}</div><div class="map-list"><div class="toc-head"><span>对话索引</span><span class="hint">${items.length} 条</span></div><div class="toc-list">${rows}</div></div></div>`)}
</body></html>`;

fs.writeFileSync(path.join(ROOT, ".toc-preview.html"), html, "utf8");
console.log("ok");
