const { app, BrowserWindow, globalShortcut, ipcMain, Notification } = require("electron");
const path = require("node:path");

const url = process.env.HUB_URL || "http://127.0.0.1:43123";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 390,
    backgroundColor: "#0c0b09",
    title: "Hub of Me",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(url).catch(() => {
    win.loadURL(`data:text/html,<body style="background:#0c0b09;color:#f3efe4;font-family:sans-serif;padding:40px"><h1>Hub of Me</h1><p>The app is not running at ${url}. Start it with npm run dev, then open the desktop shell again.</p></body>`);
  });
  return win;
}

app.whenReady().then(() => {
  const win = createWindow();
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("start-dictation");
  });
  ipcMain.on("notify", (_event, title, body) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
