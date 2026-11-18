# Local Intel

A live intel page for EVE Online: a gate map of the systems around you with kills, traffic, ratting, sov timers and wormholes, your intel channel and location read from EVE's chat logs, watched systems, alerts, and your characters' notifications.

**Open it:** https://ongrid07.github.io/OnGrid/ (the exact address is shown in the repository's Settings → Pages)

Everything runs in your browser from the single `index.html` file. Press **About** on the page for instructions, the version number and the version history.

## EVE login (for character notifications)

On the page above, open **Alerts and settings** and press **Log in with EVE**. The app is already registered and its Client ID is built in.

A copy hosted at another address needs its own app at https://developers.eveonline.com with the permission `esi-characters.read_notifications.v1`, a callback URL that matches that address exactly, and its Client ID pasted into the page. The page never needs the app's secret.

## Windows app

`desktop/` is Local Intel for Windows: the page in its own window with a tray icon, background alerts, always on top and start with Windows. Download `LocalIntel-Setup-<version>.exe` from the [releases page](https://github.com/OnGrid07/OnGrid/releases/latest). The installed app updates itself from those releases.

To publish a new app version, raise `version` in `desktop/package.json` and push to `main`: the "Build Windows app" workflow builds it on Windows and publishes the release.

## Data

CCP's EVE Swagger Interface and EVE login, zKillboard, and EVE-Scout.
