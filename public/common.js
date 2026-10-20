/*
 * Gemeinsame Helfer für Mac-Bildschirm (display.html) und Handy (phone.html):
 * DOM-Kürzel, Speicher, Toast, WebSocket-Client mit Wiederverbindung und Uhr-Abgleich.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };

  let toastTimer;
  function toast(msg, ms = 3500) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
  }

  const Net = {
    ws: null, open: false, queue: [], code: null, id: null, kind: 'device',
    clock: { offset: 0, samples: [] },
    sessKey: 'ka_sess', storage: null, onMessage: () => {}, onState: () => {},
    backoff: 500, pingTimer: null, wantConnect: false,

    init(opts) {
      Object.assign(this, opts);
      this.storage = opts.storage || window.sessionStorage;
      const s = this.loadSession();
      if (s) { this.code = s.code; this.id = s.id; }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.code && !this.open) this.connect();
      });
      return s;
    },
    loadSession() { try { return JSON.parse(this.storage.getItem(this.sessKey)); } catch { return null; } },
    saveSession(code, id) { this.code = code; this.id = id; try { this.storage.setItem(this.sessKey, JSON.stringify({ code, id })); } catch {} },
    clearSession() { this.code = null; this.id = null; try { this.storage.removeItem(this.sessKey); } catch {} },

    connect() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      this.wantConnect = true;
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      this.ws = ws;
      ws.onopen = () => {
        this.open = true; this.backoff = 500; this.onState(true);
        const q = this.queue; this.queue = [];
        if (this.code && this.id) ws.send(JSON.stringify({ type: 'rejoin', code: this.code, id: this.id }));
        q.forEach(o => ws.send(JSON.stringify(o)));
        clearInterval(this.pingTimer); this.ping(); this.pingTimer = setInterval(() => this.ping(), 4000);
      };
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'pong') return this.onPong(m);
        this.onMessage(m);
      };
      ws.onclose = () => {
        this.open = false;
        if (this.ws !== ws) return;
        this.onState(false);
        if (this.wantConnect && (this.code || this.queue.length)) {
          setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 1.6, 5000);
        }
      };
      ws.onerror = () => {};
    },
    send(o) {
      if (this.open) this.ws.send(JSON.stringify(o));
      else if (o.type === 'create' || o.type === 'join') { this.queue.push(o); this.connect(); }
    },
    close() {
      this.wantConnect = false; clearInterval(this.pingTimer);
      try { this.ws && this.ws.close(); } catch {}
      this.ws = null; this.open = false; this.queue = [];
    },

    /* Uhr-Abgleich mit dem Server: serverNow() ist auf allen Geräten (fast) gleich */
    ping() { if (this.open) this.ws.send(JSON.stringify({ type: 'ping', t0: Date.now() })); },
    onPong(m) {
      const t1 = Date.now(), rtt = t1 - m.t0, off = m.ts + rtt / 2 - t1;
      const a = this.clock.samples; a.push({ rtt, off }); if (a.length > 8) a.shift();
      this.clock.offset = a.reduce((b, x) => (x.rtt < b.rtt ? x : b)).off;
    },
    serverNow() { return Date.now() + this.clock.offset; },
    toLocal(serverTs) { return serverTs - this.clock.offset; }
  };

  window.KA = { $, $$, esc, store, toast, Net };
})();
