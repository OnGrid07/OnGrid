// The overlay windows (alert banner, intel HUD) only get these few commands from Electron.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("overlay", {
  onData: cb => ipcRenderer.on("ov:data", (e, d) => cb(d)),
  onMode: cb => ipcRenderer.on("ov:mode", (e, m) => cb(m || {})),
  dragStart: () => ipcRenderer.send("ov:drag", "start"),
  dragMove: (dx, dy) => ipcRenderer.send("ov:drag", "move", Number(dx) || 0, Number(dy) || 0),
  dragEnd: () => ipcRenderer.send("ov:drag", "end"),
  resize: h => ipcRenderer.send("ov:resize", Number(h) || 0),
  hideMe: () => ipcRenderer.send("ov:hide")
});
