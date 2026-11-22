// Gives the launcher ring a few safe commands; nothing else from Electron is reachable from the page.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ongrid", {
  open: id => ipcRenderer.send("launcher:open", String(id)),
  full: () => ipcRenderer.send("launcher:full"),
  hide: () => ipcRenderer.send("launcher:hide"),
  quit: () => ipcRenderer.send("launcher:quit"),
  dragStart: () => ipcRenderer.send("launcher:drag", "start"),
  dragMove: (dx, dy) => ipcRenderer.send("launcher:drag", "move", Number(dx) || 0, Number(dy) || 0),
  dragEnd: () => ipcRenderer.send("launcher:drag", "end"),
  onOpen: cb => ipcRenderer.on("launcher:open-ids", (e, ids) => cb(Array.isArray(ids) ? ids : []))
});
