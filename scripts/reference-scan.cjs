/**
 * 生成 Electron 版的扫描结果作为对照基准（只读，不写任何平台数据）。
 * 用法：node scripts/reference-scan.mjs > reference.json
 *      node scripts/reference-scan.mjs --read <平台> <id>
 */
const path = require("node:path");
const SOURCE = "E:\\chat session manager";
const sessions = require(path.join(SOURCE, "electron", "sessions"));

const args = process.argv.slice(2);
if (args[0] === "--read") {
  const msgs = sessions.read(args[1], args[2]);
  process.stdout.write(JSON.stringify(msgs));
} else {
  const data = sessions.listAll();
  process.stdout.write(JSON.stringify(data));
}
