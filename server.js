'use strict';
/*
 * Duett-Karaoke Server
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

const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
const cleanRole = r => (r === 'm' || r === 'f' ? r : '');
const num = (v, min, max, def = 0) => (typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}
function pub(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, role: p.role, host: p.id === room.hostId,
    online: p.online, round: p.round, total: p.total
  }));
}
function snapshot(room) {
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, players: pub(room),
    track: room.track, lines: room.lines, offset: room.offset, pos: room.pos
  };
}
function broadcastPlayers(room) {
  broadcast(room, { type: 'players', players: pub(room) });
}
function addPlayer(room, ws, name, role) {
  const p = {
    id: crypto.randomBytes(6).toString('hex'), name, role, ws,
    online: true, round: 0, total: 0, lastSeen: Date.now()
  };
  room.players.set(p.id, p);
  ws.ctx = { room, player: p };
  return p;
}
function resetRound(room) {
  for (const p of room.players.values()) p.round = 0;
}
function closeRoom(room, notify = true) {
  if (notify) broadcast(room, { type: 'closed' });
  for (const p of room.players.values()) { if (p.ws) p.ws.ctx = null; }
  rooms.delete(room.code);
}
function detach(ws) {
  const c = ws.ctx;
  if (!c) return;
  ws.ctx = null;
  if (c.player.ws === ws) { c.player.online = false; c.player.lastSeen = Date.now(); }
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
  for (const l of lines.slice(0, 400)) {
    if (!l || typeof l.text !== 'string' || typeof l.t !== 'number' || !isFinite(l.t)) continue;
    out.push({ t: Math.max(0, l.t), text: l.text.slice(0, 200), role: ['m', 'f', 'b'].includes(l.role) ? l.role : 'b' });
  }
  return out.length ? out : null;
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
    if (++ws.rl.n > 150) return ws.terminate();
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

  if (m.type === 'create') {
    if (ws.ctx) detach(ws);
    if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', msg: 'Server voll, bitte später nochmal.', fatal: true });
    const code = makeCode();
    if (!code) return send(ws, { type: 'error', msg: 'Konnte keinen Raum anlegen.', fatal: true });
    const room = {
      code, hostId: null, players: new Map(), phase: 'lobby',
      track: null, lines: null, offset: 0, pos: null, dirty: false, finishing: false
    };
    const p = addPlayer(room, ws, cleanName(m.name) || 'Host', cleanRole(m.role));
    room.hostId = p.id;
    rooms.set(code, room);
    return send(ws, { type: 'created', code, id: p.id, snap: snapshot(room) });
  }

  if (m.type === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return send(ws, { type: 'error', msg: 'Raum nicht gefunden. Code prüfen.' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', msg: 'Raum ist voll.' });
    const name = cleanName(m.name);
    if (!name) return send(ws, { type: 'error', msg: 'Bitte Namen eingeben.' });
    if (ws.ctx) detach(ws);
    const p = addPlayer(room, ws, name, cleanRole(m.role) || 'm');
    send(ws, { type: 'joined', code: room.code, id: p.id, snap: snapshot(room) });
    return broadcastPlayers(room);
  }

  if (m.type === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && room.players.get(String(m.id || ''));
    if (!p) return send(ws, { type: 'error', msg: 'Raum nicht mehr vorhanden.', fatal: true });
    if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch {} }
    p.ws = ws; p.online = true; p.lastSeen = Date.now();
    ws.ctx = { room, player: p };
    send(ws, { type: 'joined', code: room.code, id: p.id, snap: snapshot(room) });
    return broadcastPlayers(room);
  }

  const c = ws.ctx;
  if (!c) return;
  const { room, player } = c;
  const isHost = player.id === room.hostId;

  switch (m.type) {
    case 'profile': {
      const n = cleanName(m.name);
      if (n) player.name = n;
      if ('role' in m) player.role = cleanRole(m.role);
      return broadcastPlayers(room);
    }
    case 'score': {
      player.round = Math.round(num(m.score, 0, 100000, player.round));
      room.dirty = true;
      return;
    }
    case 'leave': {
      if (isHost) { closeRoom(room); return; }
      room.players.delete(player.id);
      ws.ctx = null;
      return broadcastPlayers(room);
    }
  }

  // ---- ab hier nur Host ----
  if (!isHost) return;

  switch (m.type) {
    case 'track': {
      const t = cleanTrack(m.track);
      if (!t || !t.id) return;
      room.track = t;
      room.lines = cleanLines(m.lines);
      room.phase = 'ready';
      room.pos = null;
      room.finishing = false;
      resetRound(room);
      broadcast(room, { type: 'track', track: room.track, lines: room.lines });
      return broadcastPlayers(room);
    }
    case 'roles': {
      if (!room.lines || typeof m.roles !== 'string') return;
      for (let i = 0; i < room.lines.length; i++) {
        const r = m.roles[i];
        if (r === 'm' || r === 'f' || r === 'b') room.lines[i].role = r;
      }
      return broadcast(room, { type: 'roles', roles: m.roles.slice(0, room.lines.length) }, player.id);
    }
    case 'start': {
      if (!room.track || (room.phase !== 'ready' && room.phase !== 'play')) return;
      room.phase = 'play';
      room.pos = null;
      room.finishing = false;
      resetRound(room);
      broadcast(room, { type: 'started' });
      return broadcastPlayers(room);
    }
    case 'pos': {
      if (room.phase !== 'play') return;
      const now = Date.now();
      const ts = typeof m.ts === 'number' && Math.abs(m.ts - now) < 10000 ? m.ts : now;
      room.pos = { pos: num(m.pos, 0, 7200, 0), playing: !!m.playing, ts };
      return broadcast(room, { type: 'pos', ...room.pos }, player.id);
    }
    case 'offset': {
      room.offset = num(m.value, -3, 3, 0);
      return broadcast(room, { type: 'offset', value: room.offset }, player.id);
    }
    case 'ended': {
      if (room.phase !== 'play' || room.finishing) return;
      room.finishing = true;
      broadcast(room, { type: 'finish' });
      setTimeout(() => {
        room.finishing = false;
        if (!rooms.has(room.code) || room.phase !== 'play') return;
        for (const p of room.players.values()) p.total += p.round;
        room.phase = 'results';
        broadcast(room, { type: 'results', players: pub(room) });
      }, 900);
      return;
    }
    case 'lobby': {
      room.phase = 'lobby';
      room.track = null; room.lines = null; room.pos = null; room.finishing = false;
      resetRound(room);
      broadcast(room, { type: 'lobby' });
      return broadcastPlayers(room);
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
    const host = room.players.get(room.hostId);
    if (!host || (!host.online && now - host.lastSeen > OFFLINE_HOST_MS)) { closeRoom(room); continue; }
    let changed = false;
    for (const p of [...room.players.values()]) {
      if (!p.online && p.id !== room.hostId && now - p.lastSeen > OFFLINE_PLAYER_MS) {
        room.players.delete(p.id); changed = true;
      }
    }
    if (changed) broadcastPlayers(room);
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Duett-Karaoke läuft auf Port ${PORT}` + (CLIENT_ID ? ' (Spotify Client-ID gesetzt)' : ' (keine Client-ID in der Umgebung)'));
});

module.exports = { parseLRC, cleanTitle, server, rooms };
