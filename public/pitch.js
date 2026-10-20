/*
 * Tonhöhen-Erkennung (YIN-Verfahren) für Gesang.
 * Läuft im Browser (window.Pitch) und in Node (require) für Tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pitch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FMIN = 70;    // tiefster erwarteter Ton (Hz)
  const FMAX = 1000;  // höchster erwarteter Ton (Hz)

  /**
   * @param {Float32Array} buf  Audio-Samples (Mono)
   * @param {number} sr         Samplerate
   * @returns {{f:number, prob:number}|null}
   */
  function yin(buf, sr, threshold = 0.15) {
    const W = buf.length >> 1;                      // Integrationsfenster
    const tauMin = Math.max(2, Math.floor(sr / FMAX));
    const tauMax = Math.min(W - 2, Math.floor(sr / FMIN));
    if (tauMax <= tauMin + 2) return null;

    // Differenzfunktion + kumulativ normalisiert (CMND)
    const cmnd = new Float32Array(tauMax + 2);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let d = 0;
      for (let j = 0; j < W; j++) {
        const diff = buf[j] - buf[j + tau];
        d += diff * diff;
      }
      running += d;
      cmnd[tau] = running > 0 ? (d * tau) / running : 1;
    }

    // erstes Tal unter Schwelle suchen
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // kein klares Tal: nur akzeptieren, wenn das globale Minimum noch brauchbar ist
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      if (cmnd[best] > 0.3) return null;
      tau = best;
    }

    // parabolische Interpolation für Feinauflösung
    let tauEst = tau;
    if (tau > 1 && tau < tauMax) {
      const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
      const denom = a + c - 2 * b;
      if (denom !== 0) tauEst = tau + (a - c) / (2 * denom);
    }
    const f = sr / tauEst;
    if (!(f >= FMIN && f <= FMAX)) return null;
    return { f, prob: 1 - cmnd[tau] };
  }

  const hzToMidi = f => 69 + 12 * Math.log2(f / 440);
  const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiName(m) {
    const r = Math.round(m);
    return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  }

  /** Abstand in Halbtönen zwischen zwei Tönen, Oktaven egal (0 … 6). */
  function foldedDiff(a, b) {
    let d = Math.abs(a - b) % 12;
    return d > 6 ? 12 - d : d;
  }
  /** a in die Oktave schieben, die am nächsten an ref liegt. */
  function foldNear(a, ref) {
    return a + 12 * Math.round((ref - a) / 12);
  }

  /** Glättet die Tonfolge mit einem Median über die letzten n Werte (Oktavsprünge/Ausreißer). */
  function makeSmoother(n = 3) {
    const hist = [];
    return function (m) {
      if (m == null) { hist.length = 0; return null; }
      hist.push(m); if (hist.length > n) hist.shift();
      const s = [...hist].sort((x, y) => x - y);
      return s[s.length >> 1];
    };
  }

  return { yin, hzToMidi, midiToHz, midiName, foldedDiff, foldNear, makeSmoother, FMIN, FMAX };
});
