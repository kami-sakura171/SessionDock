const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const out = path.join(ROOT, ".md-shot.png");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 860,
    height: 1400,
    show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(ROOT, ".md-preview.html"));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log("已输出", out);
  app.quit();
});
