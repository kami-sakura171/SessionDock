const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const url = process.argv[2] || "http://localhost:1420/preview.html";
const out = path.join(__dirname, "..", process.argv[3] || ".md-preview-shot.png");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 880, height: 1150, show: false, webPreferences: { offscreen: true } });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 1200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log("ok", out);
  app.quit();
});
