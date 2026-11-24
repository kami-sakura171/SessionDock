const asar = require("@electron/asar");
const fs = require("node:fs");
const path = require("node:path");

const A =
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0/app/resources/app.asar";
const files = asar.listPackage(A).filter((f) => /\.(js|mjs)$/.test(f));

const patterns = [/minimap/i, /scroll-?map/i, /message-?map/i, /jump-?to-?message/i, /turn-?marker/i];
const out = [];

for (const f of files) {
  let s;
  try {
    s = asar.extractFile(A, f.replace(/^\\/, "")).toString("utf8");
  } catch {
    continue;
  }
  for (const p of patterns) {
    const m = s.match(p);
    if (!m) continue;
    const i = m.index || 0;
    out.push(`${path.basename(f)} [${p}] ...${s.slice(Math.max(0, i - 90), i + 90).replace(/\s+/g, " ")}...`);
    break;
  }
}
console.log("js 文件", files.length, "| 命中", out.length);
console.log(out.slice(0, 10).join("\n\n"));
