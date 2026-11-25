// Loaded into OnGrid's own page windows. It lets the page hand alerts and its intel summary to the overlays
// (alert banner, intel HUD). Nothing else from Electron is reachable, and the app only accepts these messages
// from the OnGrid site.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ongridApp", {
  overlays: true,
  alert: a => ipcRenderer.send("page:alert", { title: String(a?.title || "").slice(0, 160), body: String(a?.body || "").slice(0, 300), level: a?.level === "info" ? "info" : "alert" }),
  hud: d => ipcRenderer.send("page:hud", JSON.parse(JSON.stringify(d || null))),
  trip: d => ipcRenderer.send("page:trip", JSON.parse(JSON.stringify(d || null))),
  home: d => ipcRenderer.send("page:home", JSON.parse(JSON.stringify(d || null))),
  loot: d => ipcRenderer.send("page:loot", JSON.parse(JSON.stringify(d || null))),
  mini: d => ipcRenderer.send("page:mini", { svg: String(d?.svg || "").slice(0, 600000), viewBox: String(d?.viewBox || ""), css: String(d?.css || "").slice(0, 200000) }),
  // overlay switches, so they can be set from Alerts and settings as well as the tray menu
  overlayState: () => ipcRenderer.invoke("ov:get"),
  setOverlay: o => ipcRenderer.send("ov:set", { alert: o?.alert, hud: o?.hud, trip: o?.trip, mini: o?.mini, home: o?.home, loot: o?.loot, miniSize: o?.miniSize, unlocked: o?.unlocked, opacity: o?.opacity, reset: !!o?.reset }),
  onOverlayState: cb => ipcRenderer.on("ov:state", (e, st) => cb(st)),
  // whether this window can be seen (hidden in the tray or minimized: the page skips drawing)
  onShown: cb => ipcRenderer.on("win:shown", (e, v) => cb(!!v))
});
