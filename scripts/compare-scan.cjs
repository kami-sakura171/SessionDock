/**
 * 对比 Electron 版与 Rust 版的扫描结果。
 * 用法：node scripts/compare-scan.cjs <reference.json> <rust.json>
 */
const fs = require("node:fs");

const [refPath, newPath] = process.argv.slice(2);
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
const cur = JSON.parse(fs.readFileSync(newPath, "utf8"));

const byPlatform = (list) => {
  const m = new Map();
  for (const s of list) {
    if (!m.has(s.platform)) m.set(s.platform, []);
    m.get(s.platform).push(s);
  }
  return m;
};
const keyOf = (s) => `${s.platform}:${s.id}`;
const fmt = (n) => String(n).padStart(6);

const refMap = byPlatform(ref.sessions);
const curMap = byPlatform(cur.sessions);
const platforms = [...new Set([...refMap.keys(), ...curMap.keys()])];

let problems = 0;
console.log("platform      Electron    Rust    差异");
for (const p of platforms) {
  const a = refMap.get(p) || [];
  const b = curMap.get(p) || [];
  console.log(`${p.padEnd(12)} ${fmt(a.length)} ${fmt(b.length)}    ${a.length === b.length ? "OK" : "不一致"}`);
  if (a.length !== b.length) problems++;
}

console.log("\n--- 逐条对比 ---");
for (const p of platforms) {
  const a = new Map((refMap.get(p) || []).map((s) => [s.id, s]));
  const b = new Map((curMap.get(p) || []).map((s) => [s.id, s]));
  const onlyA = [...a.keys()].filter((k) => !b.has(k));
  const onlyB = [...b.keys()].filter((k) => !a.has(k));
  for (const id of onlyA.slice(0, 5)) {
    console.log(`仅 Electron 有 ${p}:${id} 「${(a.get(id).title || "").slice(0, 40)}」`);
    problems++;
  }
  for (const id of onlyB.slice(0, 5)) {
    console.log(`仅 Rust 有     ${p}:${id} 「${(b.get(id).title || "").slice(0, 40)}」`);
    problems++;
  }
  if (onlyA.length > 5 || onlyB.length > 5) console.log(`  …（${p} 还有更多 id 差异）`);

  let fieldDiff = 0;
  for (const [id, sa] of a) {
    const sb = b.get(id);
    if (!sb) continue;
    for (const f of ["title", "project", "cwd", "messageCount", "createdAt", "updatedAt", "archived", "path"]) {
      const va = sa[f] ?? null;
      const vb = sb[f] ?? null;
      // Rust 端文件时间戳用整数毫秒，Electron 是带小数的浮点；<1ms 视为一致（界面只显示到分钟）
      const numericClose = typeof va === "number" && typeof vb === "number" && Math.abs(va - vb) < 1;
      if (va !== vb && !numericClose) {
        if (fieldDiff < 8) {
          console.log(`字段不一致 ${p}:${id} ${f}: Electron=${JSON.stringify(va)} Rust=${JSON.stringify(vb)}`);
        }
        fieldDiff++;
        problems++;
      }
    }
  }
  if (fieldDiff > 8) console.log(`  …（${p} 共 ${fieldDiff} 处字段差异）`);
}

const refErr = Object.fromEntries(ref.platforms.map((p) => [p.platform, p.error]));
const curErr = Object.fromEntries(cur.platforms.map((p) => [p.platform, p.error]));
console.log("\n--- 平台错误 ---");
for (const p of Object.keys(refErr)) {
  if (refErr[p] || curErr[p]) console.log(`${p}: Electron=${refErr[p] || "无"} Rust=${curErr[p] || "无"}`);
}

console.log(problems === 0 ? "\n✅ 完全一致" : `\n⚠️ 共 ${problems} 处差异`);
process.exit(problems === 0 ? 0 : 1);
