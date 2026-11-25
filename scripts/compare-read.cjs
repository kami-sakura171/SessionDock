/**
 * 对比两个会话详情（消息数组）：条数、角色、正文、时间戳。
 * 用法：node scripts/compare-read.cjs <label> <ref.json> <rust.json>
 */
const fs = require("node:fs");
const [label, refPath, newPath] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(refPath, "utf8"));
const b = JSON.parse(fs.readFileSync(newPath, "utf8"));

const norm = (m) => ({ role: m.role, text: (m.text || "").trim(), timestamp: m.timestamp ?? null });
const an = a.map(norm);
const bn = b.map(norm);

let diff = 0;
if (an.length !== bn.length) {
  console.log(`${label}: 条数不同 Electron=${an.length} Rust=${bn.length}`);
  diff++;
}
const n = Math.min(an.length, bn.length);
for (let i = 0; i < n; i++) {
  const x = an[i];
  const y = bn[i];
  if (x.role !== y.role) {
    console.log(`${label}#${i} 角色不同 ${x.role} vs ${y.role}`);
    if (++diff > 5) break;
  }
  if (x.text !== y.text) {
    console.log(`${label}#${i} 正文不同:\n  Electron=${JSON.stringify(x.text.slice(0, 160))}\n  Rust     =${JSON.stringify(y.text.slice(0, 160))}`);
    if (++diff > 5) break;
  }
  const ta = x.timestamp ?? 0;
  const tb = y.timestamp ?? 0;
  if (Math.abs(ta - tb) >= 1) {
    console.log(`${label}#${i} 时间不同 ${ta} vs ${tb}`);
    if (++diff > 5) break;
  }
}
console.log(diff === 0 ? `${label}: ✅ ${an.length} 条消息完全一致` : `${label}: ⚠️ ${diff} 处差异`);
process.exit(diff === 0 ? 0 : 1);
