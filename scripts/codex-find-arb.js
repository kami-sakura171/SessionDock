const asar = require("@electron/asar");
const path = require("node:path");
const A = "C:/Program Files/WindowsApps/OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0/app/resources/app.asar";
const files = asar.listPackage(A).filter((f) => /\.(js|mjs)$/.test(f));
const re = /(w-\[8px\]|h-\[2px\])/g;
const out = [];
for (const f of files) {
  let s; try { s = asar.extractFile(A, f.replace(/^\\/, "")).toString("utf8"); } catch { continue; }
  const m = re.exec(s);
  if (m) out.push(`${path.basename(f)} ...${s.slice(Math.max(0,m.index-200), m.index+260).replace(/\s+/g," ")}...`);
}
console.log("命中", out.length);
console.log(out.slice(0,3).join("\n\n"));
