const asar = require("@electron/asar");
const path = require("node:path");

const A =
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0/app/resources/app.asar";
const files = asar.listPackage(A).filter((f) => /\.(js|mjs)$/.test(f));

const re = /h-0\.5[^"'`]{0,40}w-2|w-2[^"'`]{0,40}h-0\.5/g;
const out = [];

for (const f of files) {
  let s;
  try {
    s = asar.extractFile(A, f.replace(/^\\/, "")).toString("utf8");
  } catch {
    continue;
  }
  let m;
  let count = 0;
  while ((m = re.exec(s)) && count < 2) {
    count++;
    const i = m.index;
    out.push(`${path.basename(f)}\n  ...${s.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, " ")}...`);
  }
  if (out.length > 6) break;
}
console.log("命中片段", out.length);
console.log(out.slice(0, 4).join("\n\n"));
