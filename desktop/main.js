// OnGrid for Windows: a small Electron shell around the live page at SITE.
// It opens to the launcher: a gate ring whose symbols open each box in its own window (the page with ?box=<id>);
// the centre of the ring opens the full page. The full page always runs (hidden if you don't open it), so alerts keep working.
// It loads the website, so page updates arrive without reinstalling the app.
// What the app adds: tray icon, keeps running (and alerting) when minimized or closed to the tray,
// always-on-top, start with Windows, and no repeated permission prompts for the chat logs folder.
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, Notification, net, ipcMain, screen } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

const SITE = process.env.LOCALINTEL_SITE || "https://ongrid07.github.io/OnGrid/"; // the override is only for testing
const SITE_ORIGIN = new URL(SITE).origin;
// always ask for the live page, never a stored copy, so every window runs the newest version
const FRESH = { extraHeaders: "Cache-Control: no-cache\nPragma: no-cache\n" };
const LOGIN_HOST = "login.eveonline.com";
const ICON = path.join(__dirname, "icon.png");

let win = null, tray = null, quitting = false;
const RELEASES = "https://github.com/OnGrid07/OnGrid/releases/latest";
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR; // the single-file version can't replace itself
let update = { state: "idle", version: null, error: null };
const prefsFile = () => path.join(app.getPath("userData"), "desktop-prefs.json");
let prefs = { alwaysOnTop: false, closeToTray: true, bounds: null, launcher: true, launcherPos: null, boxBounds: {},
  overlays: { alert: { on: true, pos: null }, hud: { on: true, pos: null } }, overlayUnlocked: false, overlayOpacity: 0.8 };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), "utf8")) }; } catch {}
prefs.overlays = { alert: { on: true, pos: null, ...(prefs.overlays?.alert || {}) }, hud: { on: true, pos: null, ...(prefs.overlays?.hud || {}) } };
const savePrefs = () => { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch {} };

// one copy at a time: starting it again just shows the open window
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => prefs.launcher ? showLauncher() : show());
app.setAppUserModelId("com.ongrid.app"); // needed for Windows notifications

const isOurs = url => { try { const u = new URL(url); return u.origin === SITE_ORIGIN || u.host === LOGIN_HOST; } catch { return false; } };

// the page's own links (EVE login, watched-system tabs) stay in the app; everything else opens in the normal browser
function guard(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === SITE_ORIGIN) return { action: "allow", overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, backgroundColor: "#0b0f14", webPreferences: { backgroundThrottling: false } } };
    shell.openExternal(url); return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => { if (!isOurs(url)) { e.preventDefault(); shell.openExternal(url); } });
}

function createWindow(visible = true) {
  win = new BrowserWindow({
    show: visible,
    width: prefs.bounds?.width || 1400, height: prefs.bounds?.height || 950,
    x: prefs.bounds?.x, y: prefs.bounds?.y,
    minWidth: 420, minHeight: 500,
    title: "OnGrid", icon: ICON, backgroundColor: "#0b0f14",
    alwaysOnTop: prefs.alwaysOnTop, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "page-preload.js"), backgroundThrottling: false, contextIsolation: true, sandbox: true } // keep timers and alerts running when hidden
  });
  win.loadURL(SITE, FRESH);
  guard(win);

  // no internet or the site is down: show a page that retries
  win.webContents.on("did-fail-load", (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, "offline.html"), { query: { site: SITE, reason: desc } });
  });

  win.on("close", e => {
    prefs.bounds = win.getBounds(); savePrefs();
    if (!quitting && prefs.closeToTray) {
      e.preventDefault(); win.hide();
      if (!prefs.toldTray) { prefs.toldTray = true; savePrefs(); new Notification({ title: "OnGrid is still running", body: "It keeps watching intel in the tray. Right-click the tray icon to quit.", icon: ICON }).show(); }
    }
  });
}

function show() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

/* ---------- launcher: the gate ring ---------- */
let launcher = null;
const boxWins = new Map(); // box id -> its window
const BOX_SIZE = { mapPanel: [760, 820], sysPanel: [900, 600], intelPanel: [620, 700], watchPanel: [900, 420], scanPanel: [900, 760], hostilePanel: [760, 520],
  timerPanel: [640, 560], routePanel: [560, 640], notifPanel: [640, 640], killPanel: [700, 720], settings: [980, 820], about: [760, 820] };
function createLauncher(quiet) {
  const size = 460, p = prefs.launcherPos;
  const onScreen = p && screen.getAllDisplays().some(d => p.x >= d.workArea.x - 100 && p.y >= d.workArea.y - 100 && p.x < d.workArea.x + d.workArea.width && p.y < d.workArea.y + d.workArea.height);
  launcher = new BrowserWindow({
    width: size, height: size, x: onScreen ? p.x : undefined, y: onScreen ? p.y : undefined,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    alwaysOnTop: prefs.alwaysOnTop, title: "OnGrid", icon: ICON, backgroundColor: "#00000000", show: !quiet,
    webPreferences: { preload: path.join(__dirname, "launcher-preload.js"), contextIsolation: true, sandbox: true }
  });
  launcher.loadFile(path.join(__dirname, "launcher.html"));
  if (quiet) launcher.once("ready-to-show", () => launcher.showInactive());
  launcher.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  launcher.webContents.on("will-navigate", e => e.preventDefault());
  launcher.webContents.on("did-finish-load", sendOpenIds);
  launcher.on("moved", () => { const [x, y] = launcher.getPosition(); prefs.launcherPos = { x, y }; savePrefs(); });
  launcher.on("close", e => { if (!quitting) { e.preventDefault(); launcher.hide(); } });
}
function showLauncher() { if (!launcher) createLauncher(); launcher.show(); launcher.focus(); }
function sendOpenIds() { if (launcher && !launcher.isDestroyed()) launcher.webContents.send("launcher:open-ids", [...boxWins.keys()]); }
function openBox(id, quiet) { // quiet: reopened after a restart, so don't take the focus away from the game
  if (!BOX_SIZE[id]) return;
  const open = boxWins.get(id);
  if (open && !open.isDestroyed()) { if (open.isMinimized()) open.restore(); open.show(); open.focus(); return; }
  const b = prefs.boxBounds?.[id], [w, h] = BOX_SIZE[id];
  const bw = new BrowserWindow({
    width: b?.width || w, height: b?.height || h, x: b?.x, y: b?.y, minWidth: 360, minHeight: 260,
    title: "OnGrid", icon: ICON, backgroundColor: "#0b0f14", autoHideMenuBar: true, alwaysOnTop: prefs.alwaysOnTop, show: !quiet,
    webPreferences: { preload: path.join(__dirname, "page-preload.js"), backgroundThrottling: false, contextIsolation: true, sandbox: true }
  });
  if (quiet) bw.once("ready-to-show", () => bw.showInactive());
  const url = new URL(SITE); url.searchParams.set("box", id);
  bw.loadURL(url.toString(), FRESH); guard(bw);
  bw.webContents.on("did-fail-load", (e, code, desc, u, isMain) => { if (isMain && code !== -3) bw.loadFile(path.join(__dirname, "offline.html"), { query: { site: url.toString(), reason: desc } }); });
  bw.on("close", () => { prefs.boxBounds = { ...(prefs.boxBounds || {}), [id]: bw.getBounds() }; savePrefs(); });
  bw.on("closed", () => { boxWins.delete(id); sendOpenIds(); });
  boxWins.set(id, bw); sendOpenIds();
}
// a symbol on the ring opens its box, or closes it if its window is already open
ipcMain.on("launcher:open", (e, id) => {
  if (e.sender !== launcher?.webContents) return;
  const w = boxWins.get(id);
  if (w && !w.isDestroyed()) w.close(); else openBox(id);
});
ipcMain.on("launcher:full", e => { if (e.sender === launcher?.webContents) show(); });
ipcMain.on("launcher:hide", e => { if (e.sender === launcher?.webContents) { launcher.hide(); if (!prefs.toldLauncher) { prefs.toldLauncher = true; savePrefs(); notify("The launcher is in the tray", "Click the tray icon to bring it back."); } } });
// moving the ring (the window has no frame): the launcher sends how far the pointer has moved since the drag began
let dragFrom = null;
ipcMain.on("launcher:drag", (e, what, dx, dy) => {
  if (!launcher || e.sender !== launcher.webContents) return;
  if (what === "start") { const [x, y] = launcher.getPosition(); dragFrom = { x, y }; }
  else if (what === "move" && dragFrom && Number.isFinite(dx) && Number.isFinite(dy)) launcher.setPosition(Math.round(dragFrom.x + dx), Math.round(dragFrom.y + dy));
  else if (what === "end") { dragFrom = null; const [x, y] = launcher.getPosition(); prefs.launcherPos = { x, y }; savePrefs(); }
});
ipcMain.on("launcher:quit", e => { if (e.sender === launcher?.webContents) { quitting = true; app.quit(); } });

function notify(title, body, onClick) {
  const n = new Notification({ title, body, icon: ICON });
  if (onClick) n.on("click", onClick);
  n.show();
}

/* ---------- updates ----------
   Installed copy: electron-updater checks the GitHub releases, downloads a newer version in the background
   and installs it when the app restarts (or straight away from the tray menu).
   Portable copy: it can't replace itself, so it only checks and offers the download page. */
function setupUpdates() {
  if (!app.isPackaged) return;
  if (isPortable) {
    const check = async () => {
      try {
        const r = await net.fetch("https://api.github.com/repos/OnGrid07/OnGrid/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
        const v = ((await r.json()).tag_name || "").replace(/^[^\d]*/, "");
        if (v && newer(v, app.getVersion()) && update.version !== v) {
          update = { state: "portable", version: v, error: null }; refreshTray();
          notify("OnGrid update available", `Version ${v} is out. Click to open the download page.`, () => shell.openExternal(RELEASES));
        }
      } catch {}
    };
    setTimeout(check, 15e3); setInterval(check, 6 * 36e5);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => { update.state = "checking"; refreshTray(); });
  autoUpdater.on("update-not-available", () => { update.state = "current"; refreshTray(); if (manualCheck) { manualCheck = false; notify("OnGrid is up to date", `You have the newest version, ${app.getVersion()}.`); } });
  autoUpdater.on("update-available", i => { update = { state: "downloading", version: i.version, error: null }; refreshTray(); if (manualCheck) { manualCheck = false; notify("OnGrid update found", `Downloading version ${i.version}; it installs by itself when it's ready.`); } });
  autoUpdater.on("update-downloaded", i => {
    update = { state: "ready", version: i.version, error: null }; refreshTray();
    notify("OnGrid update ready", `Version ${i.version} installs by itself in a minute or two, when you're not clicking in OnGrid. Click to restart now.`, installNow);
    // OnGrid usually runs in the tray and is never quit, so don't wait for a quit: install once no OnGrid window has
    // been in front for a minute, then start again (the install is silent and takes a few seconds)
    let idle = 0;
    clearInterval(installTimer);
    installTimer = setInterval(() => { idle = BrowserWindow.getFocusedWindow() ? 0 : idle + 1; if (idle >= 2) installNow(); }, 30e3);
  });
  autoUpdater.on("error", e => { if (manualCheck) { manualCheck = false; notify("OnGrid couldn't check for updates", String(e?.message || e).slice(0, 160)); } update.state = "error"; update.error = String(e?.message || e).slice(0, 120); refreshTray(); });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10e3); setInterval(check, 36e5);
}
let installTimer = null, manualCheck = false;
function installNow() { // silent install, then OnGrid starts again with the same box windows open
  clearInterval(installTimer); quitting = true;
  prefs.reopen = { boxes: [...boxWins.keys()], launcher: !!launcher?.isVisible(), at: Date.now() }; savePrefs();
  autoUpdater.quitAndInstall(true, true);
}
function newer(a, b) { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
function updateItems() {
  const v = app.getVersion();
  if (update.state === "ready") return [{ label: `Restart to update to ${update.version}`, click: installNow }];
  if (update.state === "portable") return [{ label: `Download version ${update.version}…`, click: () => shell.openExternal(RELEASES) }];
  const status = { checking: "Checking for updates…", downloading: `Downloading ${update.version}…`, current: `Up to date (${v})`, error: "Update check failed" }[update.state] || `Version ${v}`;
  return [{ label: status, enabled: false }, ...(isPortable || !app.isPackaged ? [] : [{ label: "Check for updates", click: () => { manualCheck = true; autoUpdater.checkForUpdates().catch(() => {}); } }])];
}
/* ---------- overlays: alert banner and intel HUD ----------
   Separate see-through windows that float above EVE (windowed or fixed-window mode). They never touch the game
   client: the page sends them its alerts and an intel summary. Locked, clicks pass straight through to EVE. */
const overlays = { alert: null, hud: null };
let lastHud = null, ovDragFrom = null;
const OV_SIZE = { alert: [600, 86], hud: [330, 150] };
function ovDefaultPos(kind) {
  const wa = screen.getPrimaryDisplay().workArea, [w] = OV_SIZE[kind];
  return kind === "alert" ? { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + 70 } : { x: Math.round(wa.x + wa.width * 0.36 - w / 2), y: wa.y + wa.height - 260 };
}
function ovPos(kind) {
  const p = prefs.overlays?.[kind]?.pos;
  const ok = p && screen.getAllDisplays().some(d => p.x >= d.workArea.x - 200 && p.y >= d.workArea.y - 50 && p.x < d.workArea.x + d.workArea.width && p.y < d.workArea.y + d.workArea.height);
  return ok ? p : ovDefaultPos(kind);
}
function ovMode(w) { if (w && !w.isDestroyed()) w.webContents.send("ov:mode", { unlocked: !!prefs.overlayUnlocked, opacity: prefs.overlayOpacity ?? 0.8 }); }
function createOverlay(kind) {
  const [w, h] = OV_SIZE[kind], p = ovPos(kind);
  const ov = new BrowserWindow({
    width: w, height: h, x: p.x, y: p.y, frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: "#00000000", title: "OnGrid " + kind,
    webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  ov.setAlwaysOnTop(true, "screen-saver"); // above EVE's window
  ov.setVisibleOnAllWorkspaces(true);
  ov.loadFile(path.join(__dirname, "overlay.html"), { query: { kind } });
  ov.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  ov.webContents.on("will-navigate", e => e.preventDefault());
  ov.webContents.on("did-finish-load", () => { ovMode(ov); if (kind === "hud") { ov.webContents.send("ov:data", lastHud); } applyOverlayState(kind); });
  ov.on("closed", () => { overlays[kind] = null; });
  overlays[kind] = ov;
}
function applyOverlayState(kind) { // show or hide, and whether clicks go through
  const ov = overlays[kind]; if (!ov || ov.isDestroyed()) return;
  const on = prefs.overlays?.[kind]?.on;
  ov.setIgnoreMouseEvents(!prefs.overlayUnlocked);
  ov.setFocusable(!!prefs.overlayUnlocked); // unlocked: fully interactive so it can be dragged; locked: never takes focus from EVE
  ovMode(ov);
  if (!on) return ov.hide();
  if (kind === "hud" || prefs.overlayUnlocked) ov.showInactive(); // the banner only shows while an alert is up (or while you place it)
  else ov.hide(); // locked again: the banner's placeholder goes away until the next alert
}
function setupOverlays() {
  for (const kind of ["alert", "hud"]) if (prefs.overlays?.[kind]?.on && !overlays[kind]) createOverlay(kind);
}
const fromSite = e => { try { return new URL(e.senderFrame?.url || e.sender.getURL()).origin === SITE_ORIGIN; } catch { return false; } };
ipcMain.on("page:alert", (e, a) => {
  if (!fromSite(e) || !prefs.overlays?.alert?.on) return;
  if (!overlays.alert) createOverlay("alert");
  const ov = overlays.alert, send = () => { ov.showInactive(); ov.setAlwaysOnTop(true, "screen-saver"); ov.webContents.send("ov:data", a); };
  ov.webContents.isLoading() ? ov.webContents.once("did-finish-load", send) : send();
});
ipcMain.on("page:hud", (e, d) => {
  if (!fromSite(e) || e.sender !== win?.webContents) return; // the full page (always running) speaks for the HUD
  lastHud = d && typeof d === "object" ? d : null;
  const ov = overlays.hud; if (ov && !ov.isDestroyed() && !ov.webContents.isLoading()) ov.webContents.send("ov:data", lastHud);
});
const ovOf = e => Object.entries(overlays).find(([, w]) => w && !w.isDestroyed() && w.webContents === e.sender) || [];
ipcMain.on("ov:drag", (e, what, dx, dy) => {
  const [kind, ov] = ovOf(e); if (!ov || !prefs.overlayUnlocked) return;
  if (what === "start") { const [x, y] = ov.getPosition(); ovDragFrom = { x, y }; }
  else if (what === "move" && ovDragFrom && Number.isFinite(dx) && Number.isFinite(dy)) ov.setPosition(Math.round(ovDragFrom.x + dx), Math.round(ovDragFrom.y + dy));
  else if (what === "end") { ovDragFrom = null; const [x, y] = ov.getPosition(); prefs.overlays[kind] = { ...prefs.overlays[kind], pos: { x, y } }; savePrefs(); }
});
ipcMain.on("ov:resize", (e, h) => { const [kind, ov] = ovOf(e); if (ov && h > 20 && h < 600) { const [w] = OV_SIZE[kind]; ov.setSize(w, Math.round(h)); } });
ipcMain.on("ov:hide", e => { const [kind, ov] = ovOf(e); if (ov && kind === "alert" && !prefs.overlayUnlocked) ov.hide(); });
// one place that changes the overlay settings, used by the tray menu and by the page's Alerts and settings
function setOverlays(o) {
  for (const kind of ["alert", "hud"]) if (typeof o[kind] === "boolean") {
    prefs.overlays[kind] = { ...prefs.overlays[kind], on: o[kind] };
    if (o[kind] && !overlays[kind]) createOverlay(kind); else applyOverlayState(kind);
  }
  if (typeof o.unlocked === "boolean") { prefs.overlayUnlocked = o.unlocked; for (const k of Object.keys(overlays)) applyOverlayState(k); }
  if (Number.isFinite(o.opacity) && o.opacity >= 0.3 && o.opacity <= 1) { prefs.overlayOpacity = o.opacity; for (const w of Object.values(overlays)) ovMode(w); }
  if (o.reset) for (const k of ["alert", "hud"]) { prefs.overlays[k] = { ...prefs.overlays[k], pos: null }; const ov = overlays[k]; if (ov && !ov.isDestroyed()) { const p = ovDefaultPos(k); ov.setPosition(p.x, p.y); } }
  savePrefs(); refreshTray(); sendOverlayState();
}
const overlayState = () => ({ alert: !!prefs.overlays.alert.on, hud: !!prefs.overlays.hud.on, unlocked: !!prefs.overlayUnlocked, opacity: prefs.overlayOpacity ?? 0.8 });
function sendOverlayState() { for (const w of [win, ...boxWins.values()]) if (w && !w.isDestroyed()) w.webContents.send("ov:state", overlayState()); }
ipcMain.handle("ov:get", e => fromSite(e) ? overlayState() : null);
ipcMain.on("ov:set", (e, o) => { if (fromSite(e) && o && typeof o === "object") setOverlays(o); });
function overlayItems() {
  return [
    { label: "Alert banner over the game", type: "checkbox", checked: !!prefs.overlays.alert.on, click: i => setOverlays({ alert: i.checked }) },
    { label: "Intel HUD over the game", type: "checkbox", checked: !!prefs.overlays.hud.on, click: i => setOverlays({ hud: i.checked }) },
    { label: "Move overlays (unlock)", type: "checkbox", checked: !!prefs.overlayUnlocked, click: i => setOverlays({ unlocked: i.checked }) },
    { label: "Overlay background", submenu: [["Light", 0.55], ["Medium", 0.8], ["Solid", 0.95]].map(([l, v]) => ({ label: l, type: "radio", checked: Math.abs((prefs.overlayOpacity ?? 0.8) - v) < 0.01, click: () => setOverlays({ opacity: v }) })) },
    { label: "Put overlays back in place", click: () => setOverlays({ reset: true }) }
  ];
}

// only for automated tests of the overlays (not used in normal running)
if (process.env.ONGRID_TEST) global.__ongridTest = {
  unlock: v => setOverlays({ unlocked: !!v }),
  toggle: (kind, on) => setOverlays({ [kind]: !!on }),
  prefs: () => JSON.parse(JSON.stringify(prefs))
};
function refreshTray() { if (tray) tray.setContextMenu(trayMenu()); }

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Show launcher", click: showLauncher },
    { label: "Show full OnGrid", click: show },
    { label: "Open to the launcher", type: "checkbox", checked: prefs.launcher, click: i => { prefs.launcher = i.checked; savePrefs(); } },
    { type: "separator" },
    ...overlayItems(),
    { type: "separator" },
    { label: "Always on top", type: "checkbox", checked: prefs.alwaysOnTop, click: i => { prefs.alwaysOnTop = i.checked; savePrefs();
      for (const w of [win, launcher, ...boxWins.values()]) if (w && !w.isDestroyed()) w.setAlwaysOnTop(i.checked); } },
    { label: "Keep running when closed", type: "checkbox", checked: prefs.closeToTray, click: i => { prefs.closeToTray = i.checked; savePrefs(); } },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: i => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: "separator" },
    { label: "Reload page", click: () => { win.webContents.reloadIgnoringCache(); for (const w of boxWins.values()) if (!w.isDestroyed()) w.webContents.reloadIgnoringCache(); } },
    { type: "separator" },
    ...updateItems(),
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } }
  ]);
}
function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip(`OnGrid ${app.getVersion()}`);
  tray.setContextMenu(trayMenu());
  tray.on("right-click", refreshTray);
  tray.on("click", () => prefs.launcher ? showLauncher() : show());
}

app.whenReady().then(() => {
  // the page only runs on the official site, so grant it what it asks for (folder reading, notifications, storage)
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(isOurs(details?.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission, origin) => isOurs(origin || wc?.getURL() || ""));
  // after an update restart: put back the launcher and box windows that were open, without stealing focus from the game
  const again = prefs.reopen && Date.now() - prefs.reopen.at < 10 * 60e3 ? prefs.reopen : null;
  if (prefs.reopen) { delete prefs.reopen; savePrefs(); }
  createWindow(!prefs.launcher && !again); // with the launcher, the full page still runs (hidden) so alerts and the tray keep working
  if (prefs.launcher && (!again || again.launcher)) createLauncher(!!again);
  if (again) for (const id of again.boxes || []) openBox(id, true);
  setupOverlays();
  buildTray();
  setupUpdates();
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (quitting) app.quit(); });
