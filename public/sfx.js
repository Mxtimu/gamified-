/* ── Amapiano / Kwaito sound cues, synthesised in the browser (no assets) ──
   Log drum = the signature Amapiano bassline: a short pitch-dropping sine with
   a hard body. Shakers and a rimshot ride on top for the kasi texture.      */
(function () {
  let ctx = null;
  let muted = localStorage.getItem('msotra.muted') === '1';

  const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

  function env(node, t, a, d, peak) {
    const g = ac().createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    node.connect(g);
    g.connect(ac().destination);
    return g;
  }

  /** The log drum: pitch falls fast, body rings a beat. */
  function logDrum(t, from = 165, to = 55, dur = 0.34, vol = 0.32) {
    const o = ac().createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.75);
    const sat = ac().createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 2.4);
    }
    sat.curve = curve;
    o.connect(sat);
    env(sat, t, 0.008, dur, vol);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise(t, dur, freq, q, vol) {
    const len = Math.max(1, Math.floor(ac().sampleRate * dur));
    const buf = ac().createBuffer(1, len, ac().sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac().createBufferSource();
    src.buffer = buf;
    const bp = ac().createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    src.connect(bp);
    env(bp, t, 0.004, dur, vol);
    src.start(t);
  }

  function blip(t, freq, dur = 0.09, vol = 0.16, type = 'triangle') {
    const o = ac().createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    env(o, t, 0.005, dur, vol);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  const CUES = {
    /** message sent — light shaker tick */
    tick: (t) => { noise(t, 0.05, 6200, 3, 0.1); },

    /** control replies — soft two-note */
    reply: (t) => { blip(t, 520, 0.08, 0.1); blip(t + 0.07, 700, 0.09, 0.08); },

    /** pin dropped on the map */
    pin: (t) => { logDrum(t, 220, 80, 0.26, 0.22); noise(t + 0.02, 0.07, 4800, 4, 0.08); },

    /** photo accepted + metadata destroyed */
    shutter: (t) => {
      noise(t, 0.035, 2600, 1.4, 0.2);
      noise(t + 0.045, 0.06, 5200, 2, 0.14);
      blip(t + 0.1, 880, 0.07, 0.1, 'square');
    },

    /** proof uploaded: the amapiano log-drum riff */
    proof: (t) => {
      const riff = [[0, 165, 55], [0.20, 196, 65], [0.40, 147, 49], [0.56, 220, 73]];
      for (const [d, a, b] of riff) logDrum(t + d, a, b, 0.32, 0.3);
      for (let i = 0; i < 8; i++) noise(t + i * 0.1, 0.05, 6000, 3, i % 2 ? 0.05 : 0.09);
      blip(t + 0.72, 659, 0.12, 0.1);
      blip(t + 0.82, 880, 0.18, 0.12);
    },

    /** coins credited — bright arpeggio over a log drum */
    coin: (t) => {
      logDrum(t, 180, 60, 0.28, 0.2);
      [784, 988, 1175, 1568].forEach((f, i) => blip(t + 0.06 * i, f, 0.13, 0.11, 'triangle'));
    },

    /** rank promotion — kwaito stab */
    rankup: (t) => {
      [[0, 392], [0.12, 523], [0.24, 659], [0.36, 784], [0.5, 1047]]
        .forEach(([d, f]) => blip(t + d, f, 0.22, 0.13, 'sawtooth'));
      logDrum(t, 150, 50, 0.4, 0.3);
      logDrum(t + 0.5, 200, 66, 0.5, 0.26);
    },

    /** voucher issued */
    voucher: (t) => {
      [[0, 659], [0.1, 880], [0.2, 1319]].forEach(([d, f]) => blip(t + d, f, 0.2, 0.12));
      noise(t + 0.24, 0.3, 3000, 1, 0.06);
    },

    /** blackout: power cut */
    blackout: (t) => {
      const o = ac().createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(240, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
      env(o, t, 0.01, 0.95, 0.2);
      o.start(t); o.stop(t + 1);
    },

    /** lights restored */
    lights: (t) => {
      noise(t, 0.25, 900, 0.7, 0.12);
      [523, 659, 784, 1047].forEach((f, i) => blip(t + 0.08 * i, f, 0.3, 0.1));
      logDrum(t + 0.3, 165, 55, 0.4, 0.28);
    },

    /** warning / tripwire */
    alert: (t) => {
      blip(t, 300, 0.14, 0.14, 'square');
      blip(t + 0.17, 220, 0.2, 0.14, 'square');
    },
  };

  window.SFX = {
    play(name) {
      if (muted || !CUES[name]) return;
      try {
        const a = ac();
        if (a.state === 'suspended') a.resume();
        CUES[name](a.currentTime + 0.01);
      } catch { /* audio unavailable — game continues silently */ }
    },
    toggle() {
      muted = !muted;
      localStorage.setItem('msotra.muted', muted ? '1' : '0');
      if (!muted) this.play('tick');
      return !muted;
    },
    get enabled() { return !muted; },
  };
})();
