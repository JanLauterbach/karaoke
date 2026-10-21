'use strict';
/*
 * Duett-Karaoke Server (v2: Mac-Bildschirm + Handy-Mikros)
 * - liefert die Web-App aus (public/)
 * - Räume + Synchronisation der Handys per WebSocket (/ws)
 * - Lyrics-Proxy zu LRCLIB (/api/lyrics)
 * Alles im Arbeitsspeicher: Neustart des Servers = Räume weg.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const QR_FILE = path.join(__dirname, 'node_modules', 'qrcode-generator', 'qrcode.js');

/* ------------------------------------------------------------------ */
/* Noten-Bibliothek aus dem Repository (Ordner songs/)                 */
/* ------------------------------------------------------------------ */
const SONGS_DIR = process.env.SONGS_DIR || path.join(__dirname, 'songs');
let songsData = { hash: '0', items: [] };
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
function loadSongs() {
  const items = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
      if (!e.isFile() || !/\.txt$/i.test(e.name) || /^readme/i.test(e.name)) continue;
      try {
        const st = fs.statSync(p); if (st.size > 2e6) continue;
        const text = decodeText(fs.readFileSync(p));
        if (/^#TITLE:/mi.test(text) && /^#BPM:/mi.test(text)) items.push({ name: path.relative(SONGS_DIR, p), text });
      } catch {}
    }
  };
  walk(SONGS_DIR, 0);
  items.sort((a, b) => a.name.localeCompare(b.name));
  const h = crypto.createHash('sha1');
  for (const it of items) { h.update(it.name); h.update('\0'); h.update(it.text); h.update('\0'); }
  songsData = { hash: h.digest('hex').slice(0, 16), items };
  console.log('Noten aus dem Repository: ' + items.length + ' Songs');
}
loadSongs();

const MAX_ROOMS = 200;
const MAX_PLAYERS = 12;
const OFFLINE_PLAYER_MS = 10 * 60 * 1000;
const OFFLINE_HOST_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Lyrics (LRCLIB)                                                     */
/* ------------------------------------------------------------------ */
const lyricsCache = new Map();
const LRC_HEADERS = { 'User-Agent': 'duett-karaoke/1.0 (private project)' };

function parseLRC(txt) {
  const out = [];
  for (const raw of String(txt).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    for (const m of stamps) out.push({ t: +m[1] * 60 + +m[2], text: text.slice(0, 200) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function cleanTitle(s) {
  return String(s)
    .replace(/\s*[-–]\s*(\d{4}\s+)?(remaster|remastered|live|radio|single|version|mono|stereo|edit|mix|from)\b.*$/i, '')
    .replace(/\s*[(\[].*?[)\]]/g, '')
    .trim();
}

async function lrcGet(url) {
  const r = await fetch(url, { headers: LRC_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  return r.json();
}

function pickClosest(arr, duration) {
  const c = (Array.isArray(arr) ? arr : []).filter(x => x && x.syncedLyrics);
  c.sort((a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration));
  return c[0] ? c[0].syncedLyrics : null;
}

async function fetchLyrics(track, artist, album, duration) {
  const key = [track, artist, duration].join('|').toLowerCase();
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  let synced = null;
  try {
    const p = new URLSearchParams({ track_name: track, artist_name: artist });
    if (album) p.set('album_name', album);
    if (duration) p.set('duration', String(duration));
    const d = await lrcGet('https://lrclib.net/api/get?' + p);
    if (d && d.syncedLyrics) synced = d.syncedLyrics;

    if (!synced) {
      const arr = await lrcGet('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: track, artist_name: artist }));
      synced = pickClosest(arr, duration || 0);
    }
    if (!synced) {
      const arr = await lrcGet('https://lrclib.net/api/search?' + new URLSearchParams({ q: cleanTitle(track) + ' ' + artist }));
      synced = pickClosest(arr, duration || 0);
    }
  } catch (e) {
    console.error('Lyrics-Fehler:', e.message);
    return null; // nicht cachen
  }
  const lines = synced ? parseLRC(synced) : null;
  const result = lines && lines.length ? lines : null;
  lyricsCache.set(key, result);
  if (lyricsCache.size > 300) lyricsCache.delete(lyricsCache.keys().next().value);
  return result;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Nicht gefunden'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'microphone=(self)'
    });
    res.end(data);
  });
}

function sendJSON(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }

  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

  // hinter Render-Proxy: http -> https
  if (req.headers['x-forwarded-proto'] === 'http') {
    res.writeHead(301, { Location: 'https://' + req.headers.host + req.url });
    return res.end();
  }

  if (url.pathname === '/config.json') return sendJSON(res, { clientId: CLIENT_ID });

  if (url.pathname === '/api/lyrics') {
    const track = (url.searchParams.get('track') || '').slice(0, 200);
    const artist = (url.searchParams.get('artist') || '').slice(0, 200);
    const album = (url.searchParams.get('album') || '').slice(0, 200);
    const duration = Math.round(+url.searchParams.get('duration')) || 0;
    if (!track) return sendJSON(res, { error: 'track fehlt' }, 400);
    const lines = await fetchLyrics(track, artist, album, duration);
    return sendJSON(res, { lines });
  }

  if (url.pathname === '/api/songs/version') return sendJSON(res, { hash: songsData.hash, n: songsData.items.length });
  if (url.pathname === '/api/songs') return sendJSON(res, { hash: songsData.hash, items: songsData.items });

  if (url.pathname === '/vendor/qrcode.js') return sendFile(res, QR_FILE);

  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  sendFile(res, file);
});


/* ------------------------------------------------------------------ */
/* Räume                                                               */
/*   display = der Mac (steuert, spielt Musik, zeigt alles)            */
/*   devices = Handys (Mikro, Name); Zuordnung (Rolle) macht der Mac   */
/* ------------------------------------------------------------------ */
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let n = 0; n < 50; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const newId = () => crypto.randomBytes(6).toString('hex');
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
const cleanRole = r => (r === 'm' || r === 'f' ? r : '');
const num = (v, min, max, def = 0) => (typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toDevices(room, obj) {
  const msg = JSON.stringify(obj);
  for (const d of room.devices.values()) if (d.ws && d.ws.readyState === 1) d.ws.send(msg);
}
function toAll(room, obj) { toDevices(room, obj); send(room.display.ws, obj); }

function pub(room) {
  return [...room.devices.values()].map(d => ({
    id: d.id, name: d.name, role: d.role, online: d.online, mic: d.mic, round: d.round, total: d.total
  }));
}
function snapshot(room, forDisplay) {
  const s = {
    code: room.code, phase: room.phase, players: pub(room),
    track: room.track, lines: room.lines, offset: room.offset, pos: room.pos
  };
  if (forDisplay) s.notes = room.notes;
  return s;
}
const broadcastPlayers = room => toAll(room, { type: 'players', players: pub(room) });

function resetRound(room) { for (const d of room.devices.values()) d.round = 0; }
function closeRoom(room, notify = true) {
  if (notify) toDevices(room, { type: 'closed' });
  for (const d of room.devices.values()) if (d.ws) d.ws.ctx = null;
  if (room.display.ws) room.display.ws.ctx = null;
  rooms.delete(room.code);
}
function detach(ws) {
  const c = ws.ctx;
  if (!c) return;
  ws.ctx = null;
  const who = c.kind === 'display' ? c.room.display : c.device;
  if (who.ws === ws) { who.online = false; who.lastSeen = Date.now(); }
  if (rooms.has(c.room.code)) broadcastPlayers(c.room);
}

function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: String(t.id || '').slice(0, 64),
    uri: String(t.uri || '').slice(0, 100),
    name: String(t.name || '').slice(0, 200),
    artist: String(t.artist || '').slice(0, 200),
    durationMs: num(t.durationMs, 0, 3600000, 0),
    cover: typeof t.cover === 'string' && t.cover.startsWith('https://') ? t.cover.slice(0, 300) : ''
  };
}
function cleanLines(lines) {
  if (!Array.isArray(lines)) return null;
  const out = [];
  for (const l of lines.slice(0, 500)) {
    if (!l || typeof l.text !== 'string' || typeof l.t !== 'number' || !isFinite(l.t)) continue;
    out.push({ t: Math.max(0, l.t), text: l.text.slice(0, 200), role: ['m', 'f', 'b'].includes(l.role) ? l.role : 'b' });
  }
  return out.length ? out : null;
}
// Noten: [[start, ende, ton, golden, teil], ...]
function cleanNotes(n) {
  if (!n || typeof n !== 'object' || !Array.isArray(n.data)) return null;
  const data = [];
  for (const r of n.data.slice(0, 6000)) {
    if (!Array.isArray(r) || r.length < 3) continue;
    const [s, e, p, g, part] = r;
    if ([s, e, p].some(v => typeof v !== 'number' || !isFinite(v))) continue;
    data.push([s, e, p, g ? 1 : 0, part === 2 ? 2 : 1]);
  }
  if (!data.length) return null;
  return { data, off: num(n.off, -60, 60, 0), name: String(n.name || '').slice(0, 120), fine: num(n.fine, -5, 5, 0) };
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.rl = { t: Date.now(), n: 0 };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    const now = Date.now();
    if (now - ws.rl.t > 5000) ws.rl = { t: now, n: 0 };
    if (++ws.rl.n > 400) return ws.terminate();
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    try { onMessage(ws, m); } catch (e) { console.error('Fehler bei', m.type, e); }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

function onMessage(ws, m) {
  if (m.type === 'ping') return send(ws, { type: 'pong', t0: m.t0, ts: Date.now() });

  /* ---------- Raum erstellen (Mac) ---------- */
  if (m.type === 'create') {
    if (ws.ctx) detach(ws);
    if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', msg: 'Server voll, bitte später nochmal.', fatal: true });
    const code = makeCode();
    if (!code) return send(ws, { type: 'error', msg: 'Konnte keinen Raum anlegen.', fatal: true });
    const room = {
      code, display: { id: newId(), ws, online: true, lastSeen: Date.now() }, devices: new Map(),
      phase: 'lobby', track: null, lines: null, notes: null, offset: 0, pos: null, dirty: false
    };
    ws.ctx = { room, kind: 'display' };
    rooms.set(code, room);
    return send(ws, { type: 'created', code, id: room.display.id, kind: 'display', snap: snapshot(room, true) });
  }

  /* ---------- Handy tritt bei ---------- */
  if (m.type === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return send(ws, { type: 'error', msg: 'Raum nicht gefunden. Code prüfen.', fatal: true });
    if (room.devices.size >= MAX_PLAYERS) return send(ws, { type: 'error', msg: 'Raum ist voll.', fatal: true });
    const name = cleanName(m.name);
    if (!name) return send(ws, { type: 'error', msg: 'Bitte Namen eingeben.' });
    if (ws.ctx) detach(ws);
    const device = { id: newId(), name, role: '', ws, online: true, mic: false, round: 0, total: 0, lastSeen: Date.now() };
    room.devices.set(device.id, device);
    ws.ctx = { room, kind: 'device', device };
    send(ws, { type: 'joined', code: room.code, id: device.id, kind: 'device', snap: snapshot(room, false) });
    return broadcastPlayers(room);
  }

  /* ---------- Wiederverbinden ---------- */
  if (m.type === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const id = String(m.id || '');
    if (!room) return send(ws, { type: 'error', msg: 'Raum nicht mehr vorhanden.', fatal: true });
    if (room.display.id === id) {
      const d = room.display;
      if (d.ws && d.ws !== ws) { d.ws.ctx = null; try { d.ws.close(); } catch {} }
      d.ws = ws; d.online = true; d.lastSeen = Date.now();
      ws.ctx = { room, kind: 'display' };
      send(ws, { type: 'joined', code: room.code, id, kind: 'display', snap: snapshot(room, true) });
      return broadcastPlayers(room);
    }
    const dev = room.devices.get(id);
    if (!dev) return send(ws, { type: 'error', msg: 'Du wurdest aus dem Raum entfernt.', fatal: true });
    if (dev.ws && dev.ws !== ws) { dev.ws.ctx = null; try { dev.ws.close(); } catch {} }
    dev.ws = ws; dev.online = true; dev.lastSeen = Date.now();
    ws.ctx = { room, kind: 'device', device: dev };
    send(ws, { type: 'joined', code: room.code, id, kind: 'device', snap: snapshot(room, false) });
    return broadcastPlayers(room);
  }

  const c = ws.ctx;
  if (!c) return;
  const { room } = c;

  /* ---------- Nachrichten vom Handy ---------- */
  if (c.kind === 'device') {
    const dev = c.device;
    switch (m.type) {
      case 'profile': {
        const n = cleanName(m.name);
        if (n) dev.name = n;
        if (typeof m.mic === 'boolean') dev.mic = m.mic;
        return broadcastPlayers(room);
      }
      case 'pitch': {
        // [[serverZeit, midi|null, pegel], ...] -> nur an den Mac weiterleiten
        if (!Array.isArray(m.s) || !room.display.online) return;
        const s = [];
        for (const r of m.s.slice(0, 30)) {
          if (!Array.isArray(r) || typeof r[0] !== 'number') continue;
          s.push([r[0], typeof r[1] === 'number' && isFinite(r[1]) ? Math.round(r[1] * 100) / 100 : null, num(r[2], 0, 1, 0)]);
        }
        if (s.length) send(room.display.ws, { type: 'pitch', id: dev.id, s });
        return;
      }
      case 'leave': {
        room.devices.delete(dev.id);
        ws.ctx = null;
        return broadcastPlayers(room);
      }
    }
    return;
  }

  /* ---------- Nachrichten vom Mac ---------- */
  switch (m.type) {
    case 'track': {
      const t = cleanTrack(m.track);
      if (!t || !t.id) return;
      room.track = t;
      room.lines = cleanLines(m.lines);
      room.notes = cleanNotes(m.notes);
      room.phase = 'ready';
      room.pos = null;
      resetRound(room);
      toDevices(room, { type: 'track', track: room.track, lines: room.lines });
      return broadcastPlayers(room);
    }
    case 'roles': {
      if (!room.lines || typeof m.roles !== 'string') return;
      for (let i = 0; i < room.lines.length; i++) {
        const r = m.roles[i];
        if (r === 'm' || r === 'f' || r === 'b') room.lines[i].role = r;
      }
      return toDevices(room, { type: 'roles', roles: m.roles.slice(0, room.lines.length) });
    }
    case 'noteOffset': {
      if (room.notes) { room.notes.fine = num(m.fine, -5, 5, 0); }
      return;
    }
    case 'assign': {
      const dev = room.devices.get(String(m.id || ''));
      if (!dev) return;
      if ('role' in m) dev.role = cleanRole(m.role);
      const n = cleanName(m.name);
      if (n) dev.name = n;
      send(dev.ws, { type: 'assigned', role: dev.role, name: dev.name });
      return broadcastPlayers(room);
    }
    case 'kick': {
      const dev = room.devices.get(String(m.id || ''));
      if (!dev) return;
      send(dev.ws, { type: 'error', msg: 'Der Host hat dich aus dem Raum entfernt.', fatal: true });
      room.devices.delete(dev.id);
      if (dev.ws) dev.ws.ctx = null;
      return broadcastPlayers(room);
    }
    case 'start': {
      if (!room.track || (room.phase !== 'ready' && room.phase !== 'play')) return;
      room.phase = 'play';
      room.pos = null;
      resetRound(room);
      toDevices(room, { type: 'started' });
      return broadcastPlayers(room);
    }
    case 'pos': {
      if (room.phase !== 'play') return;
      const now = Date.now();
      const ts = typeof m.ts === 'number' && Math.abs(m.ts - now) < 10000 ? m.ts : now;
      room.pos = { pos: num(m.pos, 0, 7200, 0), playing: !!m.playing, ts };
      return toDevices(room, { type: 'pos', ...room.pos });
    }
    case 'offset': {
      room.offset = num(m.value, -3, 3, 0);
      return toDevices(room, { type: 'offset', value: room.offset });
    }
    case 'scores': {
      if (!m.scores || typeof m.scores !== 'object') return;
      for (const [id, v] of Object.entries(m.scores)) {
        const dev = room.devices.get(id);
        if (dev) dev.round = Math.round(num(v, 0, 1000000, dev.round));
      }
      room.dirty = true;
      return;
    }
    case 'ended': {
      if (room.phase !== 'play') return;
      for (const d of room.devices.values()) d.total += d.round;
      room.phase = 'results';
      return toAll(room, { type: 'results', players: pub(room) });
    }
    case 'lobby': {
      room.phase = 'lobby';
      room.track = null; room.lines = null; room.notes = null; room.pos = null;
      resetRound(room);
      toDevices(room, { type: 'lobby' });
      return broadcastPlayers(room);
    }
    case 'leave': {
      return closeRoom(room);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hintergrund-Jobs                                                    */
/* ------------------------------------------------------------------ */
// Punktestand gebündelt verteilen
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.dirty) { room.dirty = false; broadcastPlayers(room); }
  }
}, 400);

// WebSocket-Heartbeat (Mobilfunk/Proxy hält Verbindung offen)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);

// Aufräumen
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const d = room.display;
    if (!d.online && now - d.lastSeen > OFFLINE_HOST_MS) { closeRoom(room); continue; }
    let changed = false;
    for (const dev of [...room.devices.values()]) {
      if (!dev.online && now - dev.lastSeen > OFFLINE_PLAYER_MS) { room.devices.delete(dev.id); changed = true; }
    }
    if (changed) broadcastPlayers(room);
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Duett-Karaoke läuft auf Port ${PORT}` + (CLIENT_ID ? ' (Spotify Client-ID gesetzt)' : ' (keine Client-ID in der Umgebung)'));
});

module.exports = { parseLRC, cleanTitle, server, rooms };
