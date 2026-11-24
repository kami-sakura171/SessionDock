const asar = require("@electron/asar");
const A = "E:/workbuddy/resources/app.asar";
const files = asar.listPackage(A).filter((f) => /\\renderer\\.*\.js$/.test(f));

// 特征：小尺寸 + 圆角的内联样式，通常是刻度条
const re = /height:\s*["']?[23]px["']?[^}]{0,90}borderRadius/;
const hits = [];
for (const f of files) {
  const s = asar.extractFile(A, f.replace(/^\\/, "")).toString("utf8");
  if (re.test(s)) hits.push(f);
}
console.log("候选文件", hits.length);
console.log(hits.slice(0, 15).join("\n"));
