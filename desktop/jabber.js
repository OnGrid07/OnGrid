// Jabber (XMPP) for OnGrid for Windows: pings and chat with your alliance's Jabber server.
// The connection lives here, in the app, because browsers can't connect to most Jabber servers. OnGrid's page windows
// only see messages and statuses; the password never goes to them.
// - The password is kept encrypted with Windows' own protection for your account (safeStorage), never in plain text.
// - It is only sent over an encrypted connection (TLS), to the server you typed, and the server's certificate must be valid.
// - Pings are kept on this PC (jabber-pings.json); chat stays in memory until OnGrid quits.
const { safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

const MAX_MSGS = 300, MAX_PINGS = 300;
const DEFAULT_PING_FROM = "directorbot, pingbot, pings, broadcast, broadcasts, announce";

module.exports = function setupJabber({ prefs, savePrefs, userData, send }) {
  const pingsFile = path.join(userData, "jabber-pings.json");
  let pings = [];
  try { pings = JSON.parse(fs.readFileSync(pingsFile, "utf8")); if (!Array.isArray(pings)) pings = []; } catch {}
  let lib = null, xmpp = null, status = { state: "off", text: "Not connected" }, me = null, memPassword = null, stopping = false;
  const convs = new Map(); // id -> { id, kind: "room" | "chat", title, msgs: [], unread, joined }
  let roster = [];

  const cfg = () => ({ jid: "", host: "", port: "", rooms: "", pingFrom: DEFAULT_PING_FROM, pingRooms: "", auto: true, alertChat: true, ...(prefs.jabber || {}) });
  const publicCfg = () => { const c = cfg(); return { jid: c.jid, host: c.host, port: c.port, rooms: c.rooms, pingFrom: c.pingFrom, pingRooms: c.pingRooms, auto: !!c.auto, alertChat: !!c.alertChat, hasPassword: !!(c.pw || memPassword), canStore: safeStorage.isEncryptionAvailable() }; };
  const list = s => String(s || "").split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const bare = j => String(j || "").split("/")[0].toLowerCase();
  const resOf = j => { const s = String(j || ""), i = s.indexOf("/"); return i < 0 ? "" : s.slice(i + 1); };
  const localOf = j => { const b = bare(j), i = b.indexOf("@"); return i < 0 ? "" : b.slice(0, i); };
  const roomJid = r => { r = String(r).trim().toLowerCase(); if (!r) return ""; if (r.includes("@")) return r; const d = bare(cfg().jid).split("@")[1] || ""; return d ? `${r}@conference.${d}` : ""; };

  function setStatus(state, text) { status = { state, text }; send({ type: "status", status }); }
  function convSummary(c) { const last = c.msgs[c.msgs.length - 1]; return { id: c.id, kind: c.kind, title: c.title, unread: c.unread, joined: !!c.joined, subject: c.subject || "", subjectBy: c.subjectBy || "", last: last ? { t: last.t, body: last.body.slice(0, 80) } : null }; }
  function conv(id, kind, title) {
    let c = convs.get(id);
    if (!c) {
      c = { id, kind, title: title || id, msgs: [], unread: 0, joined: false }; convs.set(id, c);
      const saved = kind === "room" && cfg().subjects?.[id]; if (saved) { c.subject = saved.text; c.subjectBy = saved.by; } // its MOTD from last time, until the room sends it again
    }
    return c;
  }
  // the rooms you're in are saved (Rooms to join), so they're joined again every time you connect
  const savedRooms = () => [...new Set([...list(cfg().rooms), ...list(cfg().pingRooms)].map(roomJid).filter(Boolean))];
  function saveRoomList(fn) {
    const c = cfg(), rooms = list(c.rooms).map(roomJid).filter(Boolean), next = fn(rooms);
    c.rooms = [...new Set(next)].join(", "); prefs.jabber = c; savePrefs(); send({ type: "cfg", cfg: publicCfg() });
  }
  const sendConvs = () => send({ type: "convs", convs: [...convs.values()].map(convSummary) });
  for (const r of savedRooms()) conv(r, "room", localOf(r) || r); // listed (with their MOTDs) even before you connect
  function addMsg(c, m) {
    if (c.msgs.some(x => (m.id && x.id === m.id && x.from === m.from) || (x.old !== undefined && m.old && x.from === m.from && x.body === m.body && Math.abs(x.t - m.t) < 2000))) return null; // room history repeats on rejoin
    c.msgs.push(m); if (c.msgs.length > MAX_MSGS) c.msgs.splice(0, c.msgs.length - MAX_MSGS);
    if (!m.me && !m.old) c.unread++;
    send({ type: "msg", conv: convSummary(c), msg: m });
    return m;
  }
  function savePings() { try { fs.writeFileSync(pingsFile, JSON.stringify(pings.slice(-MAX_PINGS))); } catch {} }
  function addPing(p) {
    if (pings.some(x => x.t === p.t && x.body === p.body)) return;
    pings.push(p); if (pings.length > MAX_PINGS) pings.splice(0, pings.length - MAX_PINGS);
    savePings(); send({ type: "ping", ping: p });
  }
  // a ping: a server broadcast or headline, a message from one of the ping senders, or anything said in a ping room
  function isPing({ from, type, body, room }) {
    const c = cfg(), b = bare(from);
    if (room) return list(c.pingRooms).some(r => roomJid(r) === room);
    if (type === "headline") return true;
    if (!b.includes("@")) return true; // from the server itself (announcements)
    if (list(c.pingFrom).some(x => x === b || x === localOf(b))) return true;
    return /this was a broadcast from/i.test(body);
  }

  async function onStanza(st) {
    if (st.is("message")) {
      const type = st.attrs.type || "normal", from = st.attrs.from || "", body = st.getChildText("body");
      if (type === "error") { const c = convs.get(bare(from)); if (c) addMsg(c, { t: Date.now(), from: "", nick: "", body: "Couldn't send: " + (errText(st) || "the server refused the message"), sys: true }); return; }
      // a room's subject (its topic or MOTD): sent when you join, and again when someone changes it
      const subj = type === "groupchat" ? st.getChild("subject") : null;
      if (subj) {
        const c = conv(bare(from), "room", localOf(from) || bare(from)), text = (subj.text() || "").trim().slice(0, 8000);
        // some servers send an empty subject while you join: that doesn't wipe the MOTD we already have
        if (text || Date.now() - (c.joinedAt || 0) > 20e3) setSubject(c, text, resOf(from));
        // ejabberd and others add "X has set the subject to: …" as text: that isn't a chat line
        if (body == null || !body.trim() || /has (set|changed) the (subject|topic)|subject (is|was|changed)|topic (is|was|changed)/i.test(body) || body.trim() === text) return;
      }
      if (body == null || !body.trim()) return;
      const stamp = st.getChild("delay", "urn:xmpp:delay")?.attrs?.stamp || st.getChild("x", "jabber:x:delay")?.attrs?.stamp;
      const t = stamp ? (Date.parse(stamp) || Date.now()) : Date.now(), old = !!stamp && Date.now() - t > 10 * 60e3;
      if (type === "groupchat") {
        const room = bare(from), nick = resOf(from), c = conv(room, "room", localOf(room) || room);
        const mine = nick === c.nick;
        const m = addMsg(c, { id: st.attrs.id || null, t, from: nick, nick, body: body.slice(0, 8000), me: mine, old: !!stamp });
        if (m && !mine && isPing({ from, type, body, room })) addPing({ t, from: `${nick} in ${c.title}`, body: body.slice(0, 8000), old });
        else if (m && !mine && !stamp && c.nick && new RegExp(`\\b${c.nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body)) send({ type: "mention", conv: convSummary(c), msg: m });
        return;
      }
      const roomHit = convs.get(bare(from))?.kind === "room"; // a private message from someone in a room
      const id = roomHit ? from : bare(from), who = roomHit ? resOf(from) : (roster.find(r => r.jid === bare(from))?.name || localOf(from) || bare(from));
      if (isPing({ from, type, body })) { addPing({ t, from: who || bare(from), body: body.slice(0, 8000), old }); return; }
      const c = conv(id, "chat", who);
      const m = addMsg(c, { id: st.attrs.id || null, t, from: who, nick: who, body: body.slice(0, 8000), me: false, old: !!stamp });
      if (m && !stamp) send({ type: "direct", conv: convSummary(c), msg: m });
      return;
    }
    if (st.is("presence")) {
      const from = st.attrs.from || "", c = convs.get(bare(from));
      if (!c || c.kind !== "room") return;
      if (st.attrs.type === "error") { c.joined = false; addMsg(c, { t: Date.now(), from: "", nick: "", body: "Couldn't join this room: " + (errText(st) || "the server refused"), sys: true }); send({ type: "convs", convs: [...convs.values()].map(convSummary) }); return; }
      if (resOf(from) === c.nick && st.attrs.type !== "unavailable" && !c.joined) { c.joined = true; send({ type: "convs", convs: [...convs.values()].map(convSummary) }); }
    }
  }
  const errText = st => { const e = st.getChild("error"); if (!e) return ""; return e.getChildText("text") || (e.children.find(x => x.name && x.name !== "text")?.name || "").replace(/-/g, " "); };

  // a room's MOTD, kept in the app's prefs so it shows again next time (even before you connect)
  function setSubject(c, text, by) {
    c.subject = text; c.subjectBy = text ? by : "";
    const p = cfg(); p.subjects = { ...(p.subjects || {}) };
    if (text) p.subjects[c.id] = { text, by: c.subjectBy }; else delete p.subjects[c.id];
    prefs.jabber = p; savePrefs(); sendConvs();
  }
  async function joinRoom(r) {
    const room = roomJid(r); if (!room || !xmpp || status.state !== "online") return;
    const { xml } = lib, c = conv(room, "room", localOf(room) || room), x = xmpp;
    c.nick = localOf(cfg().jid) || "OnGrid"; c.joinedAt = Date.now();
    await x.send(xml("presence", { to: `${room}/${c.nick}` }, xml("x", { xmlns: "http://jabber.org/protocol/muc" }, xml("history", { maxstanzas: "25" }))));
    sendConvs();
    // servers that don't send the subject on joining still list it (or the room's description) in the room's details
    setTimeout(async () => {
      if (x !== xmpp || c.subject) return;
      try {
        const info = await x.iqCaller.request(xml("iq", { type: "get", to: room }, xml("query", { xmlns: "http://jabber.org/protocol/disco#info" })), 15e3);
        const fields = info?.getChild("query")?.getChild("x", "jabber:x:data")?.getChildren("field") || [];
        const val = v => (fields.find(f => f.attrs.var === v)?.getChildText("value") || "").trim();
        const subject = val("muc#roominfo_subject"), desc = val("muc#roominfo_description");
        if (!c.subject && (subject || desc)) setSubject(c, (subject || desc).slice(0, 8000), subject ? "" : "room description");
      } catch {}
    }, 6e3);
  }

  function password() {
    if (memPassword) return memPassword;
    const enc = cfg().pw; if (!enc) return null;
    try { return safeStorage.decryptString(Buffer.from(enc, "base64")); } catch { return null; }
  }

  async function connect(opts = {}) {
    const c = { ...cfg() };
    for (const k of ["jid", "host", "port", "rooms", "pingFrom", "pingRooms"]) if (typeof opts[k] === "string") c[k] = opts[k].trim().slice(0, 2000);
    for (const k of ["auto", "alertChat"]) if (typeof opts[k] === "boolean") c[k] = opts[k];
    c.off = false;
    if (typeof opts.password === "string" && opts.password) {
      if (safeStorage.isEncryptionAvailable()) { c.pw = safeStorage.encryptString(opts.password).toString("base64"); memPassword = null; }
      else { delete c.pw; memPassword = opts.password; } // can't store it safely: keep it only until OnGrid quits
    }
    prefs.jabber = c; savePrefs();
    if (!/^[^@\s/]+@[^@\s/]+$/.test(c.jid)) { setStatus("error", "Type your Jabber ID as name@server"); return publicCfg(); }
    const pw = password(); if (!pw) { setStatus("error", "Type your Jabber password"); return publicCfg(); }
    await disconnect(true);
    lib ||= await import("@xmpp/client");
    const [username, domain] = c.jid.split("@"), host = c.host.replace(/^\w+:\/\//, "").replace(/\/.*$/, "");
    const port = +c.port || 0;
    const service = host ? (port === 5223 ? `xmpps://${host}:5223` : `xmpp://${host}:${port || 5222}`) : domain;
    stopping = false; me = null;
    const x = xmpp = lib.client({
      service, domain, resource: "OnGrid",
      // only ever send the password over an encrypted connection
      credentials: async (authenticate, mechanisms, fast, entity) => {
        if (!entity.isSecure()) throw new Error("the server didn't offer an encrypted connection, so OnGrid won't send your password");
        const mech = ["SCRAM-SHA-1", "PLAIN"].find(m => mechanisms.includes(m)) || mechanisms[0];
        await authenticate({ username, password: pw }, mech);
      }
    });
    setStatus("connecting", "Connecting to " + (host || domain) + "…");
    x.on("status", s => { if (x !== xmpp || stopping) return; if (s === "connecting" || s === "opening") setStatus("connecting", "Connecting to " + (host || domain) + "…"); else if (s === "disconnect" || s === "offline") setStatus("connecting", "Connection lost, trying again…"); });
    x.on("error", e => {
      if (x !== xmpp) return;
      const msg = String(e?.message || e), fatal = /not-authorized|auth|certificate|self.signed|encrypted connection|ENOTFOUND|unable to verify/i.test(msg) || e?.condition === "not-authorized";
      if (fatal) { stopping = true; try { x.reconnect?.stop?.(); } catch {} x.stop().catch(() => {}); setStatus("error", friendly(msg)); }
    });
    x.on("stanza", st => { if (x === xmpp) onStanza(st).catch(() => {}); });
    x.on("online", async addr => {
      if (x !== xmpp) return;
      me = addr.toString(); setStatus("online", "Connected as " + bare(me));
      try { await x.send(lib.xml("presence")); } catch {}
      try { const r = await x.iqCaller.get(lib.xml("query", "jabber:iq:roster")); roster = (r?.getChildren("item") || []).map(i => ({ jid: bare(i.attrs.jid), name: i.attrs.name || localOf(i.attrs.jid) })).filter(i => i.jid).slice(0, 2000); send({ type: "roster", roster }); } catch {}
      const keep = new Set(savedRooms());
      for (const cv of [...convs.values()]) if (cv.kind === "room") { cv.joined = false; if (!keep.has(cv.id)) convs.delete(cv.id); }
      for (const r of keep) { conv(r, "room", localOf(r) || r); joinRoom(r).catch(() => {}); }
      sendConvs();
    });
    x.start().catch(e => { if (x === xmpp && !stopping) setStatus("error", friendly(String(e?.message || e))); });
    return publicCfg();
  }
  function friendly(m) {
    if (/not-authorized|auth/i.test(m)) return "The server refused the Jabber ID or password";
    if (/certificate|self.signed|unable to verify/i.test(m)) return "The server's certificate isn't valid, so OnGrid didn't connect (" + m + ")";
    if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return "Couldn't find that server. Check the server name, or type the server under Server";
    if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(m)) return "The server didn't answer. Check the server name and port";
    return "Couldn't connect: " + m;
  }
  async function disconnect(quiet) {
    const x = xmpp; xmpp = null; stopping = true; me = null;
    for (const cv of convs.values()) cv.joined = false;
    if (x) { try { x.reconnect?.stop?.(); } catch {} try { await x.stop(); } catch {} }
    if (!quiet) setStatus("off", "Not connected");
  }
  function forget() { const c = cfg(); delete c.pw; memPassword = null; prefs.jabber = c; savePrefs(); disconnect(); return publicCfg(); }

  async function sendMsg(id, body) {
    body = String(body || "").slice(0, 4000); if (!body.trim() || !xmpp || status.state !== "online") return false;
    const c = convs.get(id) || conv(id, "chat", roster.find(r => r.jid === bare(id))?.name || localOf(id) || id);
    if (c.kind === "room") await xmpp.send(lib.xml("message", { to: c.id, type: "groupchat" }, lib.xml("body", {}, body))); // the room sends it back to us
    else { await xmpp.send(lib.xml("message", { to: c.id, type: "chat" }, lib.xml("body", {}, body))); addMsg(c, { t: Date.now(), from: "You", nick: "You", body, me: true }); }
    return true;
  }
  function open(id, kind) { // start a chat with someone, or join a room
    id = String(id || "").trim(); if (!id) return null;
    if (kind === "room") {
      const room = roomJid(id); if (!room) return null;
      conv(room, "room", localOf(room) || room); saveRoomList(rs => [...rs, room]); sendConvs();
      joinRoom(room).catch(() => {}); return room;
    }
    const j = bare(id.includes("@") ? id : `${id}@${bare(cfg().jid).split("@")[1] || ""}`);
    const c = conv(j, "chat", roster.find(r => r.jid === j)?.name || localOf(j) || j); send({ type: "convs", convs: [...convs.values()].map(convSummary) });
    return c.id;
  }
  function leave(id) {
    const c = convs.get(id); if (!c) return;
    if (c.kind === "room") {
      if (xmpp && c.nick) xmpp.send(lib.xml("presence", { to: `${c.id}/${c.nick}`, type: "unavailable" })).catch(() => {});
      const p = cfg(); p.pingRooms = list(p.pingRooms).filter(r => roomJid(r) !== c.id).join(", ");
      if (p.subjects) delete p.subjects[c.id];
      prefs.jabber = p; saveRoomList(rs => rs.filter(r => r !== c.id)); // left on purpose: not joined again
    }
    convs.delete(id); sendConvs();
  }
  function read(id) { const c = convs.get(id); if (c && c.unread) { c.unread = 0; send({ type: "convs", convs: [...convs.values()].map(convSummary) }); } }
  function history(id) { return convs.get(id)?.msgs || []; }
  function state() { return { status, cfg: publicCfg(), convs: [...convs.values()].map(convSummary), roster, pings: pings.slice(-100) }; }
  function clearPings() { pings = []; savePings(); send({ type: "pings", pings: [] }); }

  // connect by itself when OnGrid starts, if it was connected before and the password is saved
  setTimeout(() => { const c = cfg(); if (c.auto && !c.off && c.jid && password()) connect({}).catch(() => {}); }, 4000);
  // Disconnect by hand: stay disconnected next time too, until Connect is pressed again
  const userDisconnect = () => { prefs.jabber = { ...cfg(), off: true }; savePrefs(); return disconnect(false); };
  return { connect, disconnect: userDisconnect, forget, sendMsg, open, leave, read, history, state, clearPings };
};
