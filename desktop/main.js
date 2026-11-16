// Local Intel for Windows: a small Electron shell around the live page at SITE.
// It loads the website, so page updates arrive without reinstalling the app.
// What the app adds: tray icon, keeps running (and alerting) when minimized or closed to the tray,
// always-on-top, start with Windows, and no repeated permission prompts for the chat logs folder.
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");

const SITE = process.env.LOCALINTEL_SITE || "https://ongrid07.github.io/OnGrid/"; // the override is only for testing
const SITE_ORIGIN = new URL(SITE).origin;
const LOGIN_HOST = "login.eveonline.com";
const ICON = path.join(__dirname, "icon.png");

let win = null, tray = null, quitting = false;
const prefsFile = () => path.join(app.getPath("userData"), "desktop-prefs.json");
let prefs = { alwaysOnTop: false, closeToTray: true, bounds: null };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), "utf8")) }; } catch {}
const savePrefs = () => { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch {} };

// one copy at a time: starting it again just shows the open window
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => show());
app.setAppUserModelId("com.ongrid.app"); // needed for Windows notifications

const isOurs = url => { try { const u = new URL(url); return u.origin === SITE_ORIGIN || u.host === LOGIN_HOST; } catch { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: prefs.bounds?.width || 1400, height: prefs.bounds?.height || 950,
    x: prefs.bounds?.x, y: prefs.bounds?.y,
    minWidth: 420, minHeight: 500,
    title: "Local Intel", icon: ICON, backgroundColor: "#0b0f14",
    alwaysOnTop: prefs.alwaysOnTop, autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } // keep timers and alerts running when hidden
  });
  win.loadURL(SITE);

  // the page's own links (EVE login, watched-system tabs) stay in the app; everything else opens in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === SITE_ORIGIN) return { action: "allow", overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, backgroundColor: "#0b0f14", webPreferences: { backgroundThrottling: false } } };
    shell.openExternal(url); return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!isOurs(url)) { e.preventDefault(); shell.openExternal(url); } });

  // no internet or the site is down: show a page that retries
  win.webContents.on("did-fail-load", (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, "offline.html"), { query: { site: SITE, reason: desc } });
  });

  win.on("close", e => {
    prefs.bounds = win.getBounds(); savePrefs();
    if (!quitting && prefs.closeToTray) {
      e.preventDefault(); win.hide();
      if (!prefs.toldTray) { prefs.toldTray = true; savePrefs(); new Notification({ title: "Local Intel is still running", body: "It keeps watching intel in the tray. Right-click the tray icon to quit.", icon: ICON }).show(); }
    }
  });
}

function show() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Local Intel");
  const menu = () => Menu.buildFromTemplate([
    { label: "Show Local Intel", click: show },
    { type: "separator" },
    { label: "Always on top", type: "checkbox", checked: prefs.alwaysOnTop, click: i => { prefs.alwaysOnTop = i.checked; win.setAlwaysOnTop(i.checked); savePrefs(); } },
    { label: "Keep running when closed", type: "checkbox", checked: prefs.closeToTray, click: i => { prefs.closeToTray = i.checked; savePrefs(); } },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: i => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: "separator" },
    { label: "Reload page", click: () => win.loadURL(SITE) },
    { label: "Quit", click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on("right-click", () => tray.setContextMenu(menu()));
  tray.on("click", show);
}

app.whenReady().then(() => {
  // the page only runs on the official site, so grant it what it asks for (folder reading, notifications, storage)
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(isOurs(details?.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission, origin) => isOurs(origin || wc?.getURL() || ""));
  createWindow();
  buildTray();
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (quitting) app.quit(); });
