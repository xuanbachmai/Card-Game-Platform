/* ═══════════════════════════════════════════════════════════════════════════
   BÁT MÃ — Synthetic Sound Engine
   Web Audio API — no audio files, all generated programmatically.
   Global: window.SFX
   ═══════════════════════════════════════════════════════════════════════════ */

const SFX = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ── Core primitive: oscillator with gain envelope ─────────────────────── */
  function tone(freq, type, duration, gainVal, startTime, audioCtx, pitchEnd) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.type = type;
    o.frequency.setValueAtTime(freq, startTime);
    if (pitchEnd !== undefined) {
      o.frequency.exponentialRampToValueAtTime(pitchEnd, startTime + duration);
    }
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    o.start(startTime);
    o.stop(startTime + duration + 0.01);
  }

  /* ── White noise buffer helper ──────────────────────────────────────────── */
  function noiseBuffer(audioCtx, durationS) {
    const bufSize = Math.floor(audioCtx.sampleRate * durationS);
    const buffer  = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
    const data    = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function noise(audioCtx, startTime, duration, gainVal, filterFreq) {
    const buf = audioCtx.createBufferSource();
    buf.buffer = noiseBuffer(audioCtx, duration + 0.05);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(gainVal, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    if (filterFreq) {
      const filt = audioCtx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.setValueAtTime(filterFreq, startTime);
      filt.Q.setValueAtTime(0.5, startTime);
      buf.connect(filt);
      filt.connect(g);
    } else {
      buf.connect(g);
    }
    g.connect(audioCtx.destination);
    buf.start(startTime);
    buf.stop(startTime + duration + 0.05);
  }

  return {
    /* deal — short card-flutter tick (white noise burst with high-pass) */
    deal() {
      try {
        const c = getCtx();
        const t = c.currentTime;
        noise(c, t, 0.08, 0.18, 3200);
        tone(1800, 'sine', 0.04, 0.06, t + 0.01, c);
      } catch (e) { /* silently ignore audio errors */ }
    },

    /* flip — dealer reveal: quick descending swoosh */
    flip() {
      try {
        const c = getCtx();
        const t = c.currentTime;
        tone(1200, 'sine', 0.12, 0.12, t, c, 480);
        noise(c, t, 0.1, 0.08, 1800);
        tone(680, 'triangle', 0.08, 0.07, t + 0.05, c, 320);
      } catch (e) {}
    },

    /* win — ascending triadic chord: C-E-G + sparkle */
    win() {
      try {
        const c = getCtx();
        const t = c.currentTime;
        // Root triad arpeggiated
        tone(523.25, 'sine', 0.38, 0.20, t,        c); // C5
        tone(659.25, 'sine', 0.36, 0.18, t + 0.08, c); // E5
        tone(783.99, 'sine', 0.34, 0.16, t + 0.16, c); // G5
        tone(1046.5, 'sine', 0.28, 0.14, t + 0.22, c); // C6
        // Shimmer overtone
        tone(1567.98, 'sine', 0.22, 0.07, t + 0.26, c);
        // Sub bass thump
        tone(130.81, 'sine', 0.18, 0.22, t, c, 65);
      } catch (e) {}
    },

    /* lose — descending minor sad notes */
    lose() {
      try {
        const c = getCtx();
        const t = c.currentTime;
        tone(440.00, 'sine', 0.28, 0.18, t,        c, 415); // A4 → Ab4
        tone(369.99, 'sine', 0.28, 0.16, t + 0.12, c, 349); // F#4 → F4
        tone(311.13, 'sine', 0.30, 0.14, t + 0.24, c, 293); // Eb4 → D4
        tone(246.94, 'sine', 0.35, 0.12, t + 0.36, c, 220); // B3 → A3
        // Low thud
        tone(82,     'sine', 0.28, 0.20, t + 0.38, c, 50);
      } catch (e) {}
    },

    /* chip — coin click: short metallic transient */
    chip() {
      try {
        const c = getCtx();
        const t = c.currentTime;
        tone(2200, 'sine',   0.06, 0.16, t,        c, 1400);
        tone(3100, 'sine',   0.04, 0.10, t,        c, 2000);
        noise(c, t, 0.05, 0.12, 4000);
        tone(880,  'triangle', 0.05, 0.08, t + 0.02, c, 550);
      } catch (e) {}
    },

    /* shuffle — card shuffle: rapid noise bursts like riffle */
    shuffle() {
      try {
        const c = getCtx();
        const t = c.currentTime;
        // Rapid bursts simulating riffle shuffle
        for (let i = 0; i < 6; i++) {
          noise(c, t + i * 0.05, 0.055, 0.10 + Math.random() * 0.06, 2000 + Math.random() * 1500);
        }
        tone(600, 'sine', 0.30, 0.04, t, c, 400);
      } catch (e) {}
    },
  };
})();
