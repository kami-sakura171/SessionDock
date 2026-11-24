process.env.HERMES_HOME = "E:/tmp/hermes-test";
const hermes = require("../electron/sessions/hermes");
const del = require("../electron/delete");
const store = require("../electron/store");

const rows = hermes.list();
const before = { sessions: rows.length };

// 找一个可删的（不被 Hermes 运行账本保护）
let target = null;
let rec = null;
for (const r of rows) {
  try {
    rec = del.remove("hermes", r.id, r);
    target = r;
    break;
  } catch (e) {
    if (!String(e.message).includes("不允许删除")) throw e;
  }
}
if (!target) {
  console.log("FAIL 没有可删除的会话");
  process.exit(1);
}

const beforeMsgs = rows.find((x) => x.id === target.id).messageCount;
console.log(`删除目标: ${target.title.slice(0, 30)} (${beforeMsgs} 条消息)`);
console.log("删除后会话数:", hermes.list().length, "| 消息数:", hermes.read(target.id).length);

del.restore(rec.trashId);
const restoredMsgs = hermes.read(target.id).length;
const ok = hermes.list().length === before.sessions && restoredMsgs > 0;
console.log(`还原后会话数: ${hermes.list().length} | 该会话可读消息: ${restoredMsgs}`);
console.log(ok ? "PASS 删除与还原一致" : "FAIL");
store.dropTrashRecord(rec.trashId);
store.removeTrashDir(rec.dir);
process.exit(ok ? 0 : 1);
