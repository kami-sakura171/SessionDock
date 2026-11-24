const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 860, height: 640, show: false, webPreferences: { offscreen: true } });
  const file = process.argv[2] || ".toc-preview.html";
  const outName = process.argv[3] || ".toc-shot.png";
  await win.loadFile(path.join(ROOT, file));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, outName), img.toPNG());
  console.log("ok");
  app.quit();
});
