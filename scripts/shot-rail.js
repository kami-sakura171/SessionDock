const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const cssFile = fs.readdirSync(path.join(ROOT, "dist", "assets")).find((f) => f.endsWith(".css"));
const css = fs.readFileSync(path.join(ROOT, "dist", "assets", cssFile), "utf8");

const n = 28;
const ticks = Array.from({ length: n })
  .map((_, i) => `<div class="tick ${i === n - 1 ? "on" : ""}"></div>`)
  .join("");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
body{background:#f7f4ee;margin:0;height:441px;position:relative}
.drawer{position:absolute;inset:0;border:0;width:101px;min-width:101px}
</style></head><body>
<div class="drawer"><div class="map"><div class="map-rail" style="gap:12px;top:31px">${ticks}</div></div></div>
</body></html>`;
fs.writeFileSync(path.join(ROOT, ".rail-preview.html"), html, "utf8");
console.log("ok");
