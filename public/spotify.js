/*
 * Spotify für den Mac-Bildschirm: Login (PKCE, ohne Server-Geheimnis), Web-API und Web Player.
 * Der Web Player macht den Browser selbst zu einem Spotify-Gerät (Premium nötig).
 */
(function () {
  'use strict';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };

  const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
  const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  async function sha256b64(s) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  const SP = {
    cid: '',
    redirect: location.origin + '/',
    player: null, deviceId: null,

    async init() {
      try { const c = await (await fetch('/config.json')).json(); this.cid = c.clientId || ''; } catch {}
      if (!this.cid) this.cid = store.get('cid', '');
      return this.cid;
    },
    setClientId(id) { this.cid = id; store.set('cid', id); },

    async login() {
      const verifier = rand(64); store.set('sp_verifier', verifier);
      const p = new URLSearchParams({
        client_id: this.cid, response_type: 'code', redirect_uri: this.redirect, scope: SCOPES,
        code_challenge_method: 'S256', code_challenge: await sha256b64(verifier), state: 'host'
      });
      location.href = 'https://accounts.spotify.com/authorize?' + p;
    },
    logout() { ['sp_token', 'sp_exp', 'sp_refresh', 'sp_scopes'].forEach(k => store.del(k)); },

    async _tokenRequest(params) {
      try {
        const r = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: this.cid, ...params })
        });
        const d = await r.json();
        if (d.access_token) {
          store.set('sp_token', d.access_token); store.set('sp_exp', Date.now() + d.expires_in * 1000 - 60000);
          store.set('sp_scopes', SCOPES);
          if (d.refresh_token) store.set('sp_refresh', d.refresh_token);
          return true;
        }
      } catch {}
      return false;
    },
    /** Rückkehr vom Spotify-Login: ?code=… in der URL auswerten */
    async handleCallback(qs) {
      const code = qs.get('code'); if (!code) return null;
      return this._tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: this.redirect, code_verifier: store.get('sp_verifier', '')
      });
    },
    async token() {
      if (store.get('sp_scopes', '') !== SCOPES) return null;       // alter Login ohne Web-Player-Rechte
      if (Date.now() < store.get('sp_exp', 0)) return store.get('sp_token', null);
      const rt = store.get('sp_refresh', null);
      if (!rt || !this.cid) return null;
      return (await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: rt })) ? store.get('sp_token', null) : null;
    },

    async api(path, opts = {}) {
      let t = await this.token();
      if (!t) throw new Error('no-token');
      const go = tok => fetch('https://api.spotify.com/v1' + path, {
        ...opts, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
      });
      let r = await go(t);
      if (r.status === 401) { store.set('sp_exp', 0); t = await this.token(); if (t) r = await go(t); }
      return r;
    },

    async search(q) {
      const r = await this.api('/search?type=track&limit=10&q=' + encodeURIComponent(q));
      if (!r.ok) throw new Error('search-' + r.status);
      const d = await r.json();
      return d.tracks?.items || [];
    },

    /* ---------- Web Player (Browser = Spotify-Gerät) ---------- */
    _sdkPromise: null,
    loadSdk() {
      if (this._sdkPromise) return this._sdkPromise;
      this._sdkPromise = new Promise((resolve, reject) => {
        if (window.Spotify && window.Spotify.Player) return resolve();
        window.onSpotifyWebPlaybackSDKReady = () => resolve();
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.onerror = () => reject(new Error('sdk-load'));
        document.head.appendChild(s);
        setTimeout(() => reject(new Error('sdk-timeout')), 15000);
      });
      return this._sdkPromise;
    },
    /** handlers: {onReady(deviceId), onNotReady(), onError(kind, message), onState(state)} */
    async startPlayer(handlers) {
      await this.loadSdk();
      if (this.player) { try { this.player.disconnect(); } catch {} }
      const player = new window.Spotify.Player({
        name: 'Duett-Karaoke', volume: 0.9,
        getOAuthToken: cb => { this.token().then(t => cb(t || '')); }
      });
      this.player = player;
      player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; handlers.onReady && handlers.onReady(device_id); });
      player.addListener('not_ready', () => { handlers.onNotReady && handlers.onNotReady(); });
      player.addListener('initialization_error', e => handlers.onError && handlers.onError('init', e.message));
      player.addListener('authentication_error', e => handlers.onError && handlers.onError('auth', e.message));
      player.addListener('account_error', e => handlers.onError && handlers.onError('account', e.message));
      player.addListener('playback_error', e => handlers.onError && handlers.onError('playback', e.message));
      player.addListener('player_state_changed', st => { handlers.onState && handlers.onState(st); });
      const ok = await player.connect();
      if (!ok) handlers.onError && handlers.onError('connect', 'Verbindung zum Web Player fehlgeschlagen');
      return ok;
    },
    activate() { try { this.player && this.player.activateElement && this.player.activateElement(); } catch {} },

    /** Position (Sekunden) aus einem SDK-Status */
    positionOf(st) {
      if (!st) return null;
      let p = st.position;
      if (!st.paused) { const age = Date.now() - st.timestamp; if (age >= 0 && age < 10000) p += age; }
      return p / 1000;
    }
  };
  window.SP = SP;
})();
