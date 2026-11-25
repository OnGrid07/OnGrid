# OnGrid: notes for Claude

OnGrid is an intel tool for EVE Online. Everything ships from this repo.

- **`index.html`**: the whole web app in one file (HTML, CSS and JS, no build step). GitHub Pages serves it from `main` at https://ongrid07.github.io/OnGrid/.
- **`desktop/`**: "OnGrid for Windows", an Electron shell that loads the live site. Its app ID is `com.ongrid.app`.
  - It opens to a launcher, `launcher.html` with `launcher-preload.js`: a gate ring whose symbols open single boxes in their own windows. Those windows load the page with `?box=<panel id>`, or `?box=about`.
  - The full page always runs, hidden, so alerts keep working.
  - Overlays (`overlay.html`, `overlay-preload.js`): an alert banner, an intel HUD, a home HUD (danger within 3 jumps of the home system, `cfg.homeSys`), a loot HUD (while a loot session runs), a travel HUD (only during a trip) and a mini map. They're separate click-through windows above EVE and never touch the game client.
    - The page reaches them only through `page-preload.js` (`window.ongridApp.alert`, `.hud`, `.home`, `.loot`, `.trip`, `.mini`).
    - The HUDs and the mini map only take data from the full page window.
  - Never read game memory, inject into the client or automate input: that's against CCP's rules.
  - The ring and its symbols are original artwork. Don't copy another franchise's or app's art into it.
  - Jabber (`jabber.js`, `@xmpp/client`, loaded with `import()` because it's ESM): the app holds the connection; page windows talk to it only through `window.ongridApp.jabber` and get messages as `jab:ev` events.
    - The password is encrypted with `safeStorage` in the app's prefs (memory only if Windows can't protect it). It never goes to the page, localStorage, backups, the phone relay or anywhere but the Jabber server.
    - It is only sent over TLS with a valid certificate (the `credentials` hook refuses an unencrypted stream). Don't add a way to skip either check.
    - Pings are kept in `jabber-pings.json` in the app's data folder; chat is in memory only. Pings and chat never go to the phone relay.
- **`.github/workflows/desktop.yml`**: builds the Windows app on `windows-latest` when anything in `desktop/` changes on `main`, and publishes the release `v<version>`. Installed copies update themselves from these releases (`latest.yml`).

## Rules for every change

1. **Bump the version and update the About box.** Each change to the page gets a new version:
   - `const APP_VERSION = "x.yy"`
   - the comment on the first lines of `index.html`
   - `<span class="ver" id="aboutVer">Version x.yy</span>`
   - a new `<li><b>x.yy</b> …</li>` at the top of the version history in the About dialog

   If the change alters how a feature is used, update that feature's instructions in About too. Write About text in plain language for EVE players.
2. **Commit as "OnGrid".** The owner's personal GitHub name and email must never appear in this repo, in commits or in files:
   ```
   git commit --author="OnGrid <OnGrid07@users.noreply.github.com>" -m "Version x.yy: …"
   ```
   The committer may be `Claude <noreply@anthropic.com>`. Never use another name or email, and never add one to files.
3. **Push to `main` on https://github.com/OnGrid07/OnGrid.** The Pages deploy follows automatically; check it finished:
   ```
   gh api repos/OnGrid07/OnGrid/actions/runs
   ```
   If `origin` points anywhere else, push to that URL explicitly. The old personal repo is archived and must never be pushed to.
4. **Windows app releases.** Bump `desktop/package.json` `version` (and the matching root `version` in `desktop/package-lock.json`). Never change `appId` or `setAppUserModelId`: installed copies would stop updating.
5. **Never force-push, and never rewrite history,** unless the owner asks for that exact action.

## Privacy and security

- **EVE login uses PKCE with the public Client ID `398b1ea0b5714cc38e240a3cbf836079`.** There is no client secret, and none must ever be added, stored or asked for.
- **EVE login tokens** (localStorage key `chars`) stay in the browser. They must never go into backups (`BK_KEYS`), share links (`#scan=`, `#s=`), the phone relay, or anywhere else.
- **The phone relay** (ntfy.sh) is encrypted end to end with AES-GCM from the pairing code. Keep it that way.
- **The page has no backend.** Don't add analytics, trackers or any server that learns who uses it.

## Working on the page

- **Keep it one file.** External requests go only to:
  - ESI (`esi.evetech.net`)
  - zKillboard
  - EVE-Scout
  - ntfy.sh
  - `images.evetech.net`
  - Google Fonts
- **Settings live in localStorage**: `settings`, `presets`, `timers`, `intelChannels`, `panels`, `origin`, `radius`, `layout`, `bridges`. New settings go in `SETTINGS_DEFAULT` (in `cfg`) so they are saved and backed up.
- **Box layout:**
  - Boxes can be moved, resized, swapped and locked on windows at least 900 px wide.
  - `boxLayout` is stored in the `layout` key.
  - `FREE_IDS` lists the movable boxes.
  - Narrow windows and phones use the stacked layout.
- **Map style:** the map uses the original look (plain shaded dots, kill count after the name). The owner rejected a bigger redesign, so ask before restyling it.
- **Map layout:**
  - It defaults to "like the EVE star map" (`cfg.mapLayout = "eve"`, `geoLayout()`): real x/z positions, each axis half real distance and half rank order, then pushed apart so names fit.
  - "Rings by jumps" (`layoutPass()`, with region slices) is the alternative.
- **Travel map** lives in the Route planner (`#tripMap`, `#tripBar`); the Gate map only gets the compact Destination box (`#mapDest`) in its title row. Nothing may make the Gate map smaller.
- **Jump bridges** (`bridges` in localStorage, pasted in settings):
  - They're the alliance's private data: never send them anywhere except as `connections` on ESI route requests.
  - ESI takes at most 100 one-way connections per route, so `bridgeConnections()` sends the 50 bridges nearest the start-to-destination line, both ways.
- **Alts:** when several characters are logged in, `cfg.mainChar` (or the most recently active one) alone sets your location; intel lines are deduped, and each channel reads one log copy.
- **Jabber box** (`#jabberPanel`, app only, a `NO_MAP` window): pings raise `fireAlert` with keys `jp…`, direct messages and mentions with `jm…` (shown as info); neither is sent to the phone relay.
- **Loot tracker** (`#lootPanel`, app only): bounties come from EVE's game logs (Gamelogs folder, IndexedDB `gamedir`), read by one window at a time (Web Lock `ongrid-gamelogs`) into localStorage `lootBounty`; the session and pasted loot are in `loot`, pilots' corp tax in `lootTax`, ESS payouts (wallet journal `ess_escrow_transfer`, one window via Web Lock `ongrid-ess`) in `lootEss`, finished sessions in `lootHistory` (backed up). Loot is priced with ESI `markets/prices` average price.
- **Keep it light on CPU and memory** (it runs next to EVE):
  - Render functions start with `want("<panel id>")`: a box window draws only its own box, and a hidden window (`winShown` from the app's `win:shown`, or `document.hidden`) draws nothing until it shows again. Don't put alerts or shared state in render functions.
  - One window reads each local source, using a Web Lock: chat logs (`ongrid-chatlogs`, shared to other windows over BroadcastChannel), game logs and ESS. `hasOwnIntel()` means "holds the chat-log lock".
  - `NO_MAP` box windows (About, Loot tracker, notifications, settings) never load the map or kills.
  - The overlay loop only feeds overlays that are switched on, and the mini map only when the map changed (`mapDirty`).
  - The app closes overlay windows that aren't showing (`ovWanted`), and the ring only animates while hovered.
- **Hostile tracks** are colored per group (alliance, else corp, else pilot), with stacked ticker labels on the map. There are no group chips in the Hostile tracker.

## Testing

Test in Chromium with Playwright before pushing. `require('playwright')` works; don't install it again.

- **Serve the local file:** route `https://ongrid07.github.io/OnGrid/` to the local `index.html` with `context.route`.
- **Live EVE data:** proxy ESI and zKillboard calls through `curl`, and load `?system=AMAMAKE&jumps=2` for a real map.
- **Other services:** stub fonts, EVE-Scout, ntfy and images.
- **Syntax check:** extract the `<script>` and run `node --check` on it.
- **Before reporting done:** check `pageerror` stays empty, and look at a screenshot of the changed area.
