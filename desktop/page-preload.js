// Loaded into OnGrid's own page windows. It lets the page hand alerts and its intel summary to the overlays
// (alert banner, intel HUD). Nothing else from Electron is reachable, and the app only accepts these messages
// from the OnGrid site.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ongridApp", {
  overlays: true,
  alert: a => ipcRenderer.send("page:alert", { title: String(a?.title || "").slice(0, 160), body: String(a?.body || "").slice(0, 300), level: a?.level === "info" ? "info" : "alert" }),
  hud: d => ipcRenderer.send("page:hud", JSON.parse(JSON.stringify(d || null)))
});
