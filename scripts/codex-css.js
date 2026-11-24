const asar = require("@electron/asar");
const fs = require("node:fs");
const path = require("node:path");

const A =
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0/app/resources/app.asar";
const out = "E:/tmp/codexcss";
fs.mkdirSync(out, { recursive: true });

const files = asar.listPackage(A).filter((f) => f.endsWith(".css"));
const widthRe = /width:\s*8px/;
const heightRe = /height:\s*2px/;
const ruleRe = /([^{}]+)\{([^}]*)\}/g;

let n = 0;
const hits = [];
for (const f of files) {
  const s = asar.extractFile(A, f.replace(/^\\/, "")).toString("utf8");
  fs.writeFileSync(path.join(out, path.basename(f)), s);
  n++;
  let m;
  while ((m = ruleRe.exec(s))) {
    const body = m[2];
    if (widthRe.test(body) && heightRe.test(body)) {
      hits.push(`${path.basename(f)} :: ${m[1].trim().slice(0, 70)} :: ${body.slice(0, 110)}`);
    }
  }
}
console.log("css 文件", n, "| 命中 8x2 规则", hits.length);
console.log(hits.slice(0, 12).join("\n"));
