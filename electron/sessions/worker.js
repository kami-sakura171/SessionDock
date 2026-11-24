const { parentPort } = require("node:worker_threads");
const { listAll } = require("./index");

/**
 * 扫描放在工作线程里跑：Cursor 那 2GB 库的索引扫描再快也有百毫秒级，
 * 放主线程会卡住窗口重绘和 IPC。
 */
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "scan") return;
  try {
    parentPort.postMessage({ type: "result", gen: msg.gen, seq: msg.seq, data: listAll() });
  } catch (e) {
    parentPort.postMessage({ type: "error", gen: msg.gen, seq: msg.seq, message: e.message });
  }
});
