const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hubDesktop", {
  onStartDictation(callback) {
    const listener = () => callback();
    ipcRenderer.on("start-dictation", listener);
    return () => ipcRenderer.removeListener("start-dictation", listener);
  },
  notify(title, body) {
    ipcRenderer.send("notify", String(title), String(body));
  },
});
