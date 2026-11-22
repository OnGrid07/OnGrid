// Gives the launcher ring a few safe commands; nothing else from Electron is reachable from the page.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ongrid", {
  open: id => ipcRenderer.send("launcher:open", String(id)),
  full: () => ipcRenderer.send("launcher:full"),
  hide: () => ipcRenderer.send("launcher:hide"),
  quit: () => ipcRenderer.send("launcher:quit"),
  onOpen: cb => ipcRenderer.on("launcher:open-ids", (e, ids) => cb(Array.isArray(ids) ? ids : []))
});
