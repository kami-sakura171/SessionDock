const asar = require("@electron/asar");
const path = require("node:path");

const A =
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0/app/resources/app.asar";
const files = asar.listPackage(A).filter((f) => /\.(js|mjs)$/.test(f));

const w = /width:\s*8\b/;
const h = /height:\s*2\b/;
const out = [];

for (const f of files) {
  let s;
  try {
    s = asar.extractFile(A, f.replace(/^\\/, "")).toString("utf8");
  } catch {
    continue;
  }
  const iw = s.search(w);
  if (iw < 0) continue;
  const ih = s.search(h);
  if (ih < 0) continue;
  // 两者距离不太远才可能是同一个组件
  if (Math.abs(iw - ih) > 4000) continue;
  const i = Math.min(iw, ih);
  out.push(`${path.basename(f)} @${i}\n  ...${s.slice(Math.max(0, i - 260), i + 260).replace(/\s+/g, " ")}...`);
}

console.log("命中", out.length);
console.log(out.slice(0, 6).join("\n\n"));
