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
const LOGIN_HOST = "login.eveonline.com";
const ICON = path.join(__dirname, "icon.png");

let win = null, tray = null, quitting = false;
const RELEASES = "https://github.com/OnGrid07/OnGrid/releases/latest";
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR; // the single-file version can't replace itself
let update = { state: "idle", version: null, error: null };
const prefsFile = () => path.join(app.getPath("userData"), "desktop-prefs.json");
let prefs = { alwaysOnTop: false, closeToTray: true, bounds: null, launcher: true, launcherPos: null, boxBounds: {} };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), "utf8")) }; } catch {}
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
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } // keep timers and alerts running when hidden
  });
  win.loadURL(SITE);
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
function createLauncher() {
  const size = 460, p = prefs.launcherPos;
  const onScreen = p && screen.getAllDisplays().some(d => p.x >= d.workArea.x - 100 && p.y >= d.workArea.y - 100 && p.x < d.workArea.x + d.workArea.width && p.y < d.workArea.y + d.workArea.height);
  launcher = new BrowserWindow({
    width: size, height: size, x: onScreen ? p.x : undefined, y: onScreen ? p.y : undefined,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    alwaysOnTop: prefs.alwaysOnTop, title: "OnGrid", icon: ICON, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "launcher-preload.js"), contextIsolation: true, sandbox: true }
  });
  launcher.loadFile(path.join(__dirname, "launcher.html"));
  launcher.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  launcher.webContents.on("will-navigate", e => e.preventDefault());
  launcher.webContents.on("did-finish-load", sendOpenIds);
  launcher.on("moved", () => { const [x, y] = launcher.getPosition(); prefs.launcherPos = { x, y }; savePrefs(); });
  launcher.on("close", e => { if (!quitting) { e.preventDefault(); launcher.hide(); } });
}
function showLauncher() { if (!launcher) createLauncher(); launcher.show(); launcher.focus(); }
function sendOpenIds() { if (launcher && !launcher.isDestroyed()) launcher.webContents.send("launcher:open-ids", [...boxWins.keys()]); }
function openBox(id) {
  if (!BOX_SIZE[id]) return;
  const open = boxWins.get(id);
  if (open && !open.isDestroyed()) { if (open.isMinimized()) open.restore(); open.show(); open.focus(); return; }
  const b = prefs.boxBounds?.[id], [w, h] = BOX_SIZE[id];
  const bw = new BrowserWindow({
    width: b?.width || w, height: b?.height || h, x: b?.x, y: b?.y, minWidth: 360, minHeight: 260,
    title: "OnGrid", icon: ICON, backgroundColor: "#0b0f14", autoHideMenuBar: true, alwaysOnTop: prefs.alwaysOnTop,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
  });
  const url = new URL(SITE); url.searchParams.set("box", id);
  bw.loadURL(url.toString()); guard(bw);
  bw.webContents.on("did-fail-load", (e, code, desc, u, isMain) => { if (isMain && code !== -3) bw.loadFile(path.join(__dirname, "offline.html"), { query: { site: url.toString(), reason: desc } }); });
  bw.on("close", () => { prefs.boxBounds = { ...(prefs.boxBounds || {}), [id]: bw.getBounds() }; savePrefs(); });
  bw.on("closed", () => { boxWins.delete(id); sendOpenIds(); });
  boxWins.set(id, bw); sendOpenIds();
}
ipcMain.on("launcher:open", (e, id) => { if (e.sender === launcher?.webContents) openBox(id); });
ipcMain.on("launcher:full", e => { if (e.sender === launcher?.webContents) show(); });
ipcMain.on("launcher:hide", e => { if (e.sender === launcher?.webContents) { launcher.hide(); if (!prefs.toldLauncher) { prefs.toldLauncher = true; savePrefs(); notify("The launcher is in the tray", "Click the tray icon to bring it back."); } } });
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
  autoUpdater.on("update-not-available", () => { update.state = "current"; refreshTray(); });
  autoUpdater.on("update-available", i => { update = { state: "downloading", version: i.version, error: null }; refreshTray(); });
  autoUpdater.on("update-downloaded", i => {
    update = { state: "ready", version: i.version, error: null }; refreshTray();
    notify("OnGrid update ready", `Version ${i.version} installs next time the app starts. Click to restart now.`, () => { quitting = true; autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on("error", e => { update.state = "error"; update.error = String(e?.message || e).slice(0, 120); refreshTray(); });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10e3); setInterval(check, 4 * 36e5);
}
function newer(a, b) { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
function updateItems() {
  const v = app.getVersion();
  if (update.state === "ready") return [{ label: `Restart to update to ${update.version}`, click: () => { quitting = true; autoUpdater.quitAndInstall(); } }];
  if (update.state === "portable") return [{ label: `Download version ${update.version}…`, click: () => shell.openExternal(RELEASES) }];
  const status = { checking: "Checking for updates…", downloading: `Downloading ${update.version}…`, current: `Up to date (${v})`, error: "Update check failed" }[update.state] || `Version ${v}`;
  return [{ label: status, enabled: false }, ...(isPortable || !app.isPackaged ? [] : [{ label: "Check for updates", click: () => autoUpdater.checkForUpdates().catch(() => {}) }])];
}
function refreshTray() { if (tray) tray.setContextMenu(trayMenu()); }

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Show launcher", click: showLauncher },
    { label: "Show full OnGrid", click: show },
    { label: "Open to the launcher", type: "checkbox", checked: prefs.launcher, click: i => { prefs.launcher = i.checked; savePrefs(); } },
    { type: "separator" },
    { label: "Always on top", type: "checkbox", checked: prefs.alwaysOnTop, click: i => { prefs.alwaysOnTop = i.checked; savePrefs();
      for (const w of [win, launcher, ...boxWins.values()]) if (w && !w.isDestroyed()) w.setAlwaysOnTop(i.checked); } },
    { label: "Keep running when closed", type: "checkbox", checked: prefs.closeToTray, click: i => { prefs.closeToTray = i.checked; savePrefs(); } },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: i => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: "separator" },
    { label: "Reload page", click: () => { win.loadURL(SITE); for (const w of boxWins.values()) if (!w.isDestroyed()) w.reload(); } },
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
  createWindow(!prefs.launcher); // with the launcher, the full page still runs (hidden) so alerts and the tray keep working
  if (prefs.launcher) createLauncher();
  buildTray();
  setupUpdates();
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (quitting) app.quit(); });
