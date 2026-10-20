/*
 * UltraStar-Notendateien (.txt): einlesen, Songs erkennen, Zeiten zum Spotify-Titel abgleichen.
 * Läuft im Browser (window.UltraStar) und in Node (require) für Tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UltraStar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Text einer UltraStar-Datei -> { title, artist, bpm, gap, lines, notes } oder null */
  function parse(text) {
    if (typeof text !== 'string') return null;
    text = text.replace(/^﻿/, '');
    const rows = text.split(/\r?\n/);
    const tags = {};
    const notes = [];
    const lineBreaks = []; // Beat-Positionen der Zeilenumbrüche
    let part = 1, hasDuet = false;
    let relOffset = 0;

    for (const raw of rows) {
      const row = raw.replace(/\s+$/, '');
      if (!row) continue;
      if (row[0] === '#') {
        const i = row.indexOf(':');
        if (i > 0) tags[row.slice(1, i).trim().toUpperCase()] = row.slice(i + 1).trim();
        continue;
      }
      if (row[0] === 'E') break;
      if (row[0] === 'P' && /^P\s*[12]/i.test(row)) { part = row.match(/[12]/)[0] === '2' ? 2 : 1; hasDuet = true; relOffset = 0; continue; }
    }
    const relative = /^yes$/i.test(tags.RELATIVE || '');
    part = 1; relOffset = 0;
    let curLineIdx = 0;

    for (const raw of rows) {
      const row = raw;                       // Leerzeichen am Ende der Silbe bleiben erhalten (Wortgrenze)
      if (!row.trim() || row[0] === '#') continue;
      const c = row[0];
      if (c === 'E') break;
      if (c === 'P') { const m = row.match(/^P\s*([12])/i); if (m) { part = +m[1]; relOffset = 0; curLineIdx++; } continue; }
      if (c === '-') {
        const p = row.slice(1).trim().split(/\s+/).map(Number);
        const b = (p[0] || 0) + (relative ? relOffset : 0);
        lineBreaks.push({ beat: b, part });
        if (relative && p.length > 1 && isFinite(p[1])) relOffset += p[1];
        curLineIdx++;
        continue;
      }
      if (c === ':' || c === '*' || c === 'F' || c === 'R' || c === 'G') {
        // Form: <typ> <start> <dauer> <ton> <text...>
        const m = row.match(/^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)(?:\s(.*))?$/);
        if (!m) continue;
        const start = +m[2] + (relative ? relOffset : 0), dur = +m[3];
        notes.push({
          beat: start, dur, pitch: +m[4] + 60,
          text: m[5] == null ? '' : m[5],
          golden: c === '*', free: c === 'F',
          part, line: curLineIdx
        });
      }
    }
    if (!notes.length) return null;

    const bpm = parseFloat(String(tags.BPM || '').replace(',', '.'));
    const gap = parseFloat(String(tags.GAP || '0').replace(',', '.')) || 0;
    if (!(bpm > 0)) return null;
    const sPerBeat = 15 / bpm;                 // UltraStar: Beat = 1/4 der angegebenen BPM
    const toSec = b => gap / 1000 + b * sPerBeat;

    // Noten -> Sekunden
    const outNotes = notes
      .map(n => ({ s: toSec(n.beat), e: toSec(n.beat + n.dur), p: n.pitch, g: n.golden ? 1 : 0, f: n.free ? 1 : 0, text: n.text, part: n.part, line: n.line }))
      .sort((a, b) => a.s - b.s);

    // Zeilen: Noten mit gleicher line-Nummer
    const byLine = new Map();
    for (const n of outNotes) { if (!byLine.has(n.line)) byLine.set(n.line, []); byLine.get(n.line).push(n); }
    const lines = [];
    for (const [, arr] of byLine) {
      const txt = arr.map(n => n.text).join('').replace(/\s+/g, ' ').replace(/~/g, '').trim();
      if (!txt) continue;
      lines.push({ t: arr[0].s, end: arr[arr.length - 1].e, text: txt, part: arr[0].part });
    }
    lines.sort((a, b) => a.t - b.t);

    return {
      title: tags.TITLE || '', artist: tags.ARTIST || '',
      bpm, gap, duet: hasDuet, lines,
      notes: outNotes.filter(n => !n.f).map(n => [round3(n.s), round3(n.e), n.p, n.g, n.part])
    };
  }
  const round3 = x => Math.round(x * 1000) / 1000;

  /** Titel/Interpret vergleichbar machen */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s*[(\[].*?[)\]]/g, ' ')
      .replace(/\s+[-–]\s+(\d{4}\s+)?(remaster|remastered|live|radio|single|version|mono|stereo|edit|mix|from)\b.*$/i, ' ')
      .replace(/\b(feat|ft|featuring|with)\b.*$/i, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9äöüß ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /** Bibliothekseintrag zu Spotify-Titel finden. entries: [{title, artist, ...}] */
  function findMatch(entries, name, artists) {
    const t = norm(name);
    if (!t) return null;
    const arts = (Array.isArray(artists) ? artists : [artists]).map(norm).filter(Boolean);
    let titleOnly = null;
    for (const e of entries) {
      if (norm(e.title) !== t) continue;
      const ea = norm(e.artist);
      if (arts.some(a => a === ea || ea.includes(a) || a.includes(ea))) return e;
      if (!titleOnly) titleOnly = e;
    }
    // Titel passt, Interpret nicht sicher: nur nehmen, wenn kein Interpret in der Datei steht
    return titleOnly && !norm(titleOnly.artist) ? titleOnly : null;
  }

  /**
   * Zeitversatz (Sekunden), den man auf die Notenzeiten addieren muss, damit sie zu den
   * Lyrics (LRCLIB) passen. Wertet gleiche Textzeilen aus und nimmt den häufigsten Versatz.
   */
  function estimateOffset(usLines, lrcLines) {
    if (!usLines.length || !lrcLines.length) return { offset: 0, matches: 0 };
    const lrcMap = new Map();
    lrcLines.forEach(l => {
      const k = norm(l.text); if (k.length < 5) return;
      if (!lrcMap.has(k)) lrcMap.set(k, []); lrcMap.get(k).push(l.t);
    });
    const deltas = [];
    for (const u of usLines) {
      const k = norm(u.text); if (k.length < 5) continue;
      const hit = lrcMap.get(k);
      if (hit) { for (const t of hit) deltas.push(t - u.t); continue; }
      for (const [lk, times] of lrcMap) {
        if (Math.min(lk.length, k.length) >= 10 && (lk.startsWith(k) || k.startsWith(lk))) for (const t of times) deltas.push(t - u.t);
      }
    }
    if (!deltas.length) {
      return { offset: lrcLines[0].t - usLines[0].t, matches: 0 };
    }
    // häufigster Versatz (0,5-s-Klassen), dann Median darin
    const bins = new Map();
    for (const d of deltas) { const b = Math.round(d * 2); bins.set(b, (bins.get(b) || 0) + 1); }
    let bestBin = 0, bestN = -1;
    for (const [b, n] of bins) if (n > bestN) { bestBin = b; bestN = n; }
    const inBin = deltas.filter(d => Math.round(d * 2) === bestBin).sort((a, b) => a - b);
    return { offset: inBin[inBin.length >> 1], matches: bestN };
  }

  return { parse, norm, findMatch, estimateOffset };
});
