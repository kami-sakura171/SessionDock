const fs = require("node:fs");
const path = require("node:path");
const dir = "E:/tmp/wbcss";
const out = [];
for (const f of fs.readdirSync(dir)) {
  const s = fs.readFileSync(path.join(dir, f), "utf8");
  // 抓取包含 2px/3px 高度的小元素规则
  const re = /([^{}]+)\{([^}]*height:\s*[23]px[^}]*)\}/g;
  let m;
  while ((m = re.exec(s))) {
    const sel = m[1].trim().split("\n").pop().trim();
    const body = m[2].trim();
    if (/width:\s*(\d{1,2})px/.test(body)) {
      out.push(`${f}\n  ${sel}\n  ${body}\n`);
    }
  }
}
console.log(out.slice(0, 30).join("\n"));
console.log("总计", out.length);
