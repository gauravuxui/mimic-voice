// Audio engine: playback, synthesized sound packs, UI sfx and mic recording.

export const ctx = new (window.AudioContext || window.webkitAudioContext)();
export const master = ctx.createGain();
master.gain.value = 0.9;
export const outAnalyser = ctx.createAnalyser();
outAnalyser.fftSize = 1024;
master.connect(outAnalyser);
outAnalyser.connect(ctx.destination);
const sfxBus = ctx.createGain();
sfxBus.gain.value = 0.32;
sfxBus.connect(master);

export function resume() {
  if (ctx.state !== 'running') return ctx.resume();
}

const tbuf = new Float32Array(1024);
function levelOf(an) {
  an.getFloatTimeDomainData(tbuf);
  let s = 0;
  for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
  return Math.sqrt(s / tbuf.length);
}
export const outLevel = () => levelOf(outAnalyser);

// ---------- playback ----------
let current = null;
export function playBuffer(buffer, onEnd) {
  stopPlayback();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(master);
  const t0 = ctx.currentTime + 0.03;
  src.start(t0);
  const h = {
    duration: buffer.duration,
    ended: false,
    progress: () => Math.min(1, Math.max(0, (ctx.currentTime - t0) / buffer.duration)),
  };
  src.onended = () => {
    h.ended = true;
    if (current && current.src === src) current = null;
    onEnd && onEnd();
  };
  current = { src, h };
  return h;
}
export function stopPlayback() {
  if (!current) return;
  current.src.onended = null;
  current.h.ended = true;
  try { current.src.stop(); } catch {}
  current = null;
}
export function playAndWait(buffer, onHandle) {
  return new Promise((res) => {
    const h = playBuffer(buffer, res);
    onHandle && onHandle(h);
  });
}

// ---------- offline synth ----------
const SRATE = 44100;

function autom(param, pts, mode, scaleT, scaleV) {
  if (typeof pts === 'number') { param.setValueAtTime(pts * scaleV, 0); return; }
  const [t0, v0] = pts[0];
  const first = Math.max(v0 * scaleV, mode === 'exp' ? 1 : 0);
  // hold the first value from time 0, otherwise params sit at their defaults (gain 1, 440 Hz) until t0
  param.setValueAtTime(first, 0);
  param.setValueAtTime(first, t0 * scaleT);
  for (let i = 1; i < pts.length; i++) {
    const [t, v] = pts[i];
    if (mode === 'exp') param.exponentialRampToValueAtTime(Math.max(v * scaleV, 1), t * scaleT);
    else param.linearRampToValueAtTime(v * scaleV, t * scaleT);
  }
}
const lastT = (pts) => (typeof pts === 'number' ? 0 : pts[pts.length - 1][0]);

function makeSynth(oc, out, o) {
  const S = o.s, P = o.p;
  let noiseBuf = null;
  const getNoise = () => {
    if (noiseBuf) return noiseBuf;
    noiseBuf = oc.createBuffer(1, SRATE * 2, SRATE);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  };

  // parallel band-pass formant bank, used for vowel-like sounds
  function formants(input, fpts, nasal) {
    const sum = oc.createGain();
    const dry = oc.createGain(); dry.gain.value = 0.06;
    input.connect(dry).connect(sum);
    const specs = [[1, nasal ? 10 : 6, 1], [2, nasal ? 12 : 8, 0.55], [null, 10, 0.25]];
    specs.forEach(([idx, q, g]) => {
      const bp = oc.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = q;
      if (idx === null) bp.frequency.value = 2600;
      else autom(bp.frequency, fpts.map((p) => [p[0], p[idx]]), 'exp', S, 1);
      const gg = oc.createGain(); gg.gain.value = g * 3;
      input.connect(bp).connect(gg).connect(sum);
    });
    return sum;
  }

  function addVib(osc, vib, end) {
    if (!vib) return;
    const lfo = oc.createOscillator(); lfo.frequency.value = vib.rate;
    const lg = oc.createGain();
    lg.gain.setValueAtTime(vib.depth, 0);
    if (vib.depthEnd !== undefined) lg.gain.linearRampToValueAtTime(vib.depthEnd, end);
    lfo.connect(lg).connect(osc.detune);
    lfo.start(0); lfo.stop(end + 0.05);
  }

  return {
    tone({ type = 'square', f, g, vib, lp }) {
      const end = Math.max(lastT(f), lastT(g)) * S;
      const osc = oc.createOscillator();
      osc.type = o.voice ? 'sawtooth' : type;
      autom(osc.frequency, f, 'exp', S, P);
      addVib(osc, vib, end);
      let node = osc;
      if (lp) { const fl = oc.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; node.connect(fl); node = fl; }
      if (o.voice) node = formants(node, [[0, 750, 1200]]);
      const vca = oc.createGain();
      autom(vca.gain, g, 'lin', S, 1);
      node.connect(vca).connect(out);
      osc.start(0); osc.stop(end + 0.05);
    },
    voice({ f, fm, g, vib, nasal }) {
      const end = Math.max(lastT(f), lastT(g)) * S;
      const osc = oc.createOscillator(); osc.type = 'sawtooth';
      autom(osc.frequency, f, 'exp', S, P);
      addVib(osc, vib || { rate: 5.5, depth: 18 }, end);
      const vca = oc.createGain();
      autom(vca.gain, g, 'lin', S, 1);
      formants(osc, fm, nasal).connect(vca).connect(out);
      osc.start(0); osc.stop(end + 0.05);
    },
    noise({ g, lp, hp, bp, q = 1 }) {
      const end = lastT(g) * S;
      const src = oc.createBufferSource(); src.buffer = getNoise(); src.loop = true;
      let node = src;
      const filt = (type, fr) => { const fl = oc.createBiquadFilter(); fl.type = type; fl.frequency.value = fr; fl.Q.value = q; node.connect(fl); node = fl; };
      if (lp) filt('lowpass', lp);
      if (hp) filt('highpass', hp);
      if (bp) filt('bandpass', bp * P);
      const vca = oc.createGain();
      autom(vca.gain, g, 'lin', S, 1);
      node.connect(vca).connect(out);
      src.start(0); src.stop(end + 0.05);
    },
    // sequence of short notes: [[freq, dur, gap?], ...]
    notes(type, list, { at = 0, level = 0.5, lp, vibLast } = {}) {
      let t = at;
      list.forEach(([fr, d, gap = 0], i) => {
        const vib = i === list.length - 1 ? vibLast : undefined;
        this.tone({ type, lp, vib, f: [[t, fr], [t + d, fr]], g: [[t, 0], [t + 0.008, level], [t + d * 0.8, level * 0.85], [t + d, 0]] });
        t += d + gap;
      });
    },
  };
}

function normalize(buf, target = 0.85) {
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < d.length; i++) d[i] *= target / peak;
  return buf;
}

export async function renderClip(def, opts = {}) {
  const o = { p: 1, s: 1, voice: false, ...opts };
  const dur = def.dur * o.s + 0.12;
  const oc = new OfflineAudioContext(1, Math.ceil(dur * SRATE), SRATE);
  const out = oc.createGain();
  const comp = oc.createDynamicsCompressor();
  comp.threshold.value = -10; comp.ratio.value = 4;
  out.connect(comp).connect(oc.destination);
  def.build(makeSynth(oc, out, o));
  return normalize(await oc.startRendering());
}

// ---------- sound packs ----------
const clip = (id, name, stars, dur, build) => ({ id, name, stars, dur, build });

const SYNTH_PACKS = [
  {
    id: 'arcade', name: 'Arcade Classics', icon: '🕹️', color: '#4aa3ff',
    clips: [
      clip('coin', 'coin-grab', 1, 0.5, (s) => s.tone({ f: [[0, 988], [0.075, 988], [0.085, 1319], [0.45, 1319]], g: [[0, 0], [0.005, 0.5], [0.3, 0.35], [0.46, 0]] })),
      clip('jump', 'jump-boing', 1, 0.36, (s) => s.tone({ f: [[0, 180], [0.26, 720]], g: [[0, 0], [0.01, 0.5], [0.22, 0.4], [0.33, 0]] })),
      clip('powerup', 'power-up', 2, 0.66, (s) => s.notes('square', [[392, 0.08], [494, 0.08], [587, 0.08], [784, 0.08], [988, 0.08], [1175, 0.08], [1568, 0.14]])),
      clip('gameover', 'game-over', 2, 1.55, (s) => s.notes('triangle', [[523, 0.26, 0.04], [392, 0.26, 0.04], [330, 0.26, 0.04], [262, 0.6]], { level: 0.7, vibLast: { rate: 6, depth: 35 } })),
      clip('laser', 'pew-pew-pew', 2, 0.72, (s) => [0, 0.25, 0.5].forEach((t) => s.tone({ type: 'sawtooth', lp: 4000, f: [[t, 1600], [t + 0.16, 220]], g: [[t, 0], [t + 0.005, 0.5], [t + 0.17, 0]] }))),
    ],
  },
  {
    id: 'memes', name: 'Meme Sounds', icon: '😂', color: '#ff5fa2',
    clips: [
      clip('boom', 'dramatic-boom', 1, 1.25, (s) => {
        s.tone({ type: 'sine', f: [[0, 95], [0.1, 55], [1.1, 40]], g: [[0, 0], [0.005, 1], [0.3, 0.6], [1.2, 0]] });
        s.tone({ type: 'triangle', f: [[0, 190], [0.1, 110], [0.6, 80]], g: [[0, 0], [0.005, 0.35], [0.6, 0]] });
        s.noise({ lp: 450, g: [[0, 0], [0.005, 0.7], [0.18, 0]] });
      }),
      clip('trombone', 'sad-trombone', 2, 2.2, (s) => s.notes('sawtooth', [[311, 0.36, 0.04], [294, 0.36, 0.04], [277, 0.36, 0.04], [262, 1.0]], { lp: 1500, level: 0.6, vibLast: { rate: 6, depth: 45 } })),
      clip('airhorn', 'air-horn', 2, 1.3, (s) => [[0, 0.18], [0.26, 0.14], [0.48, 0.75]].forEach(([t, d]) => {
        [[415, 0.4], [423, 0.35], [830, 0.15]].forEach(([fr, lv]) => s.tone({ type: 'sawtooth', lp: 3200, f: [[t, fr], [t + d, fr]], g: [[t, 0], [t + 0.01, lv], [t + d - 0.02, lv], [t + d, 0]] }));
      })),
      clip('dun', 'dun-dun-dunnn', 2, 2.0, (s) => s.notes('sawtooth', [[294, 0.3, 0.12], [277, 0.3, 0.12], [247, 1.15]], { lp: 900, level: 0.7, vibLast: { rate: 5, depth: 30 } })),
      clip('boing', 'cartoon-boing', 3, 0.9, (s) => s.tone({ type: 'sine', f: [[0, 220], [0.8, 330]], vib: { rate: 14, depth: 420, depthEnd: 20 }, g: [[0, 0], [0.01, 0.8], [0.85, 0]] })),
      clip('wow', 'anime-wow', 2, 1.0, (s) => s.voice({ f: [[0, 280], [0.35, 480], [0.9, 260]], fm: [[0, 300, 800], [0.3, 700, 1150], [0.9, 350, 700]], g: [[0, 0], [0.05, 0.8], [0.75, 0.7], [0.95, 0]] })),
    ],
  },
  {
    id: 'robots', name: 'Robots & Sci-Fi', icon: '🤖', color: '#46e0c3',
    clips: [
      clip('beep', 'robot-beep-boop', 2, 0.8, (s) => s.notes('square', [[880, 0.12, 0.05], [660, 0.12, 0.05], [990, 0.1, 0.05], [523, 0.28]], { lp: 3000 })),
      clip('siren', 'wee-woo-siren', 1, 1.3, (s) => s.tone({ type: 'triangle', f: [[0, 650], [0.3, 950], [0.6, 650], [0.9, 950], [1.2, 650]], g: [[0, 0], [0.03, 0.6], [1.15, 0.6], [1.25, 0]] })),
      clip('warp', 'warp-drive', 2, 1.0, (s) => s.tone({ type: 'sine', f: [[0, 180], [0.9, 1800]], vib: { rate: 9, depth: 60 }, g: [[0, 0], [0.05, 0.6], [0.8, 0.6], [0.98, 0]] })),
      clip('ufo', 'ufo-wobble', 1, 1.3, (s) => s.tone({ type: 'sine', f: [[0, 520], [1.2, 540]], vib: { rate: 7, depth: 250 }, g: [[0, 0], [0.05, 0.6], [1.1, 0.6], [1.25, 0]] })),
      clip('powerdown', 'power-down', 1, 1.3, (s) => s.tone({ type: 'sawtooth', lp: 2500, f: [[0, 900], [1.2, 55]], g: [[0, 0], [0.02, 0.6], [1.1, 0.5], [1.25, 0]] })),
    ],
  },
  {
    id: 'animals', name: 'Animals', icon: '🐮', color: '#ffc94a',
    clips: [
      clip('meow', 'cat-meow', 1, 0.9, (s) => s.voice({ f: [[0, 500], [0.25, 720], [0.8, 430]], fm: [[0, 350, 2200], [0.3, 850, 1300], [0.8, 400, 850]], g: [[0, 0], [0.04, 0.8], [0.65, 0.7], [0.85, 0]], vib: { rate: 6, depth: 30 } })),
      clip('moo', 'cow-moo', 1, 1.5, (s) => s.voice({ f: [[0, 125], [0.4, 150], [1.4, 108]], fm: [[0, 320, 800], [0.5, 420, 850], [1.4, 300, 700]], g: [[0, 0], [0.1, 0.9], [1.2, 0.8], [1.45, 0]] })),
      clip('woof', 'dog-woof', 2, 0.6, (s) => [0, 0.35].forEach((t) => {
        s.voice({ f: [[t, 420], [t + 0.18, 230]], fm: [[t, 650, 1150], [t + 0.18, 550, 1000]], g: [[t, 0], [t + 0.01, 1], [t + 0.18, 0]] });
        s.noise({ bp: 900, q: 2, g: [[t, 0], [t + 0.005, 0.4], [t + 0.08, 0]] });
      })),
      clip('quack', 'duck-quack', 2, 0.72, (s) => [0, 0.25, 0.5].forEach((t) => s.voice({ nasal: true, f: [[t, 330], [t + 0.15, 280]], fm: [[t, 1000, 1800], [t + 0.15, 900, 1600]], g: [[t, 0], [t + 0.01, 0.9], [t + 0.12, 0.7], [t + 0.16, 0]] }))),
      clip('tweet', 'bird-tweet', 3, 0.5, (s) => [0, 0.13, 0.26, 0.39].forEach((t) => s.tone({ type: 'sine', f: [[t, 2200], [t + 0.07, 3600]], g: [[t, 0], [t + 0.01, 0.6], [t + 0.08, 0]] }))),
    ],
  },
];

// synth recipes by clip id (used by the Lab bots and the scoring test page)
export const SYNTH = Object.fromEntries(SYNTH_PACKS.flatMap((p) => p.clips.map((c) => [c.id, c])));

// Resolve a clip key "packId/clipId" to an AudioBuffer: built-in clips are synthesized,
// uploaded ones are fetched from the server.
const cache = new Map();
export function getClip(key, packs) {
  if (cache.has(key)) return cache.get(key);
  const [pid, cid] = key.split('/');
  const pack = packs.find((p) => p.id === pid);
  const meta = pack && pack.clips.find((c) => c.id === cid);
  let pr;
  if (meta?.url) pr = fetch(meta.url).then((r) => { if (!r.ok) throw new Error('clip fetch failed'); return r.arrayBuffer(); }).then((ab) => ctx.decodeAudioData(ab)).then((b) => normalize(toMono(b)));
  else pr = Promise.reject(new Error('unknown clip ' + key));
  pr.catch(() => cache.delete(key));
  cache.set(key, pr);
  return pr;
}
export async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed');
  return ctx.decodeAudioData(await r.arrayBuffer());
}
function toMono(b) {
  if (b.numberOfChannels === 1) return b;
  const out = ctx.createBuffer(1, b.length, b.sampleRate);
  const o = out.getChannelData(0);
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) o[i] += d[i] / b.numberOfChannels; }
  return out;
}

// 16-bit PCM mono WAV, resampled to `outRate`
export async function encodeWav(samples, sr, outRate = 22050) {
  let data = samples;
  if (sr !== outRate && samples.length) {
    const oc = new OfflineAudioContext(1, Math.max(1, Math.ceil((samples.length * outRate) / sr)), outRate);
    const b = oc.createBuffer(1, samples.length, sr);
    b.getChannelData(0).set(samples);
    const s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start();
    data = (await oc.startRendering()).getChannelData(0);
  }
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, outRate, true);
  v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  return buf;
}

// uploaded sound: decode, trim silence, cap at 6s, normalize
export async function decodeUpload(file) {
  const raw = await ctx.decodeAudioData(await file.arrayBuffer());
  const sr = raw.sampleRate, len = raw.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < raw.numberOfChannels; c++) {
    const d = raw.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / raw.numberOfChannels;
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const th = peak * 0.03;
  let a = 0, b = len - 1;
  while (a < len && Math.abs(mono[a]) < th) a++;
  while (b > a && Math.abs(mono[b]) < th) b--;
  a = Math.max(0, a - Math.floor(sr * 0.02));
  b = Math.min(len - 1, b + Math.floor(sr * 0.05), a + sr * 6);
  const out = ctx.createBuffer(1, b - a + 1, sr);
  out.getChannelData(0).set(mono.subarray(a, b + 1));
  return normalize(out);
}

// ---------- UI sfx (realtime) ----------
function blip(type, f0, f1, dur, vol = 1, delay = 0) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(sfxBus);
  o.start(t); o.stop(t + dur + 0.02);
}
function burst(dur, f, vol = 0.6, delay = 0, type = 'bandpass') {
  const t = ctx.currentTime + delay;
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = ctx.createBufferSource(); src.buffer = b;
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = 1.2;
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(fl).connect(g).connect(sfxBus); src.start(t);
}
export const sfx = {
  toss: () => burst(0.18, 1800, 0.25),
  hit: (kind) => {
    if (kind === 'bottle') { blip('sine', 320, 110, 0.14, 0.9); burst(0.25, 2500, 0.5, 0.02, 'highpass'); }
    else if (kind === 'shoe') { blip('triangle', 190, 80, 0.12, 1); burst(0.08, 600, 0.8); }
    else { blip('square', 1400, 300, 0.04, 0.5); blip('sine', 150, 55, 0.2, 1); burst(0.06, 3000, 0.6); }
  },
  step: () => burst(0.05, 400, 0.25, 0, 'lowpass'),
  tick: () => blip('square', 1800, 1200, 0.03, 0.35),
  pop: () => blip('sine', 400, 900, 0.1, 0.8),
  click: () => blip('triangle', 700, 500, 0.06, 0.6),
  beep: () => blip('sine', 660, 660, 0.14, 0.8),
  go: () => blip('sine', 1320, 1320, 0.18, 0.8),
  whoosh: () => {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const b = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = b;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3000, t + 0.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.15); g.gain.linearRampToValueAtTime(0, t + 0.45);
    src.connect(f).connect(g).connect(sfxBus); src.start(t);
  },
  ding: (n = 0) => { blip('sine', 988 + n * 120, 988 + n * 120, 0.5, 0.6); blip('sine', 1976 + n * 240, 1976 + n * 240, 0.3, 0.2); },
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => { blip('square', f, f, i === 3 ? 0.6 : 0.14, 0.35, i * 0.13); blip('triangle', f / 2, f / 2, i === 3 ? 0.6 : 0.14, 0.4, i * 0.13); }),
  sad: () => [392, 370, 349, 330].forEach((f, i) => blip('triangle', f, i === 3 ? f * 0.9 : f, i === 3 ? 0.6 : 0.2, 0.5, i * 0.22)),
  glitch: () => { for (let i = 0; i < 8; i++) blip('square', 80 + Math.random() * 1500, 60 + Math.random() * 800, 0.05, 0.4, i * 0.05); },
  count: () => blip('square', 1400, 1400, 0.02, 0.15),
};

// ---------- microphone ----------
// The mic is tapped continuously by an AudioWorklet; every block carries its audio-clock
// frame index, so a recording is cut out by audio-clock time instead of by timers.
// That removes the late start that setTimeout + ScriptProcessor buffering caused.
let micStream = null, micAnalyser = null, micLatency = 0.05;
const ring = []; // { f: startFrame, d: Float32Array }
export async function initMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const lat = micStream.getAudioTracks()[0]?.getSettings?.().latency;
  if (typeof lat === 'number' && lat > 0 && lat < 0.5) micLatency = lat;
  const src = ctx.createMediaStreamSource(micStream);
  micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
  src.connect(micAnalyser);
  await ctx.audioWorklet.addModule(new URL('./rec-worklet.js', import.meta.url));
  const tap = new AudioWorkletNode(ctx, 'rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
  tap.port.onmessage = (e) => {
    ring.push(e.data);
    const keep = e.data.f - ctx.sampleRate * 15;
    while (ring.length && ring[0].f < keep) ring.shift();
  };
}
export const micReady = () => !!micStream;
export const micLevel = () => (micAnalyser ? levelOf(micAnalyser) : 0);
export const getMicLatency = () => micLatency;

// samples captured between audio-clock times t0..t1 (seconds); latency-compensated
export function captured(t0, t1) {
  const sr = ctx.sampleRate;
  const f0 = Math.floor((t0 + micLatency) * sr), f1 = Math.floor((t1 + micLatency) * sr);
  const out = new Float32Array(Math.max(0, f1 - f0));
  for (const c of ring) {
    if (c.f + c.d.length <= f0 || c.f >= f1) continue;
    const a = Math.max(f0, c.f), b = Math.min(f1, c.f + c.d.length);
    out.set(c.d.subarray(a - c.f, b - c.f), a - f0);
  }
  return out;
}
// newest captured audio-clock time (seconds, latency-compensated)
export function capturedUntil() {
  const c = ring[ring.length - 1];
  return c ? (c.f + c.d.length) / ctx.sampleRate - micLatency : 0;
}

export function toBuffer(samples, sr = ctx.sampleRate) {
  const b = ctx.createBuffer(1, Math.max(1, samples.length), sr);
  b.getChannelData(0).set(samples);
  return b;
}

// play at an absolute audio-clock time
export function playAt(buffer, when, onEnd) {
  stopPlayback();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(master);
  const t0 = Math.max(ctx.currentTime + 0.01, when);
  src.start(t0, Math.max(0, ctx.currentTime - when > 0 ? ctx.currentTime - when : 0));
  const h = { duration: buffer.duration, ended: false, progress: () => Math.min(1, Math.max(0, (ctx.currentTime - when) / buffer.duration)) };
  src.onended = () => { h.ended = true; if (current && current.src === src) current = null; onEnd && onEnd(); };
  current = { src, h };
  return h;
}

// Sabotage: static noise + random voice cut-outs. Stacks with more saboteurs.
export function applySabotage(samples, sr, strength = 1) {
  const out = new Float32Array(samples);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const noiseAmp = Math.max(peak, 0.05) * Math.min(0.4, 0.2 * strength);
  let i = Math.floor(sr * (0.1 + Math.random() * 0.25));
  while (i < out.length) {
    const cut = Math.floor(sr * (0.08 + Math.random() * 0.1) * Math.min(1.6, strength));
    for (let k = 0; k < cut && i + k < out.length; k++) out[i + k] = 0;
    i += cut + Math.floor(sr * (0.35 + Math.random() * 0.4) / Math.min(1.6, strength));
  }
  let crackle = 0;
  for (let k = 0; k < out.length; k++) {
    if (Math.random() < 0.0008) crackle = 1;
    crackle *= 0.995;
    out[k] += (Math.random() * 2 - 1) * noiseAmp * (0.6 + crackle);
  }
  return out;
}

// "Crap mic" sabotage: sounds like a cheap, broken mic – narrow band, crushed, clipped, hum + crackle.
export function applyCrapMic(samples, sr) {
  const out = new Float32Array(samples.length);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const norm = peak > 0 ? 1 / peak : 1;
  const hold = Math.max(1, Math.round(sr / 4000)); // ~4 kHz sample-and-hold = aliasing fizz
  const hpA = Math.exp((-2 * Math.PI * 600) / sr), lpA = Math.exp((-2 * Math.PI * 2200) / sr);
  let held = 0, hpPrevIn = 0, hpPrevOut = 0, lp = 0, crackle = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i % hold === 0) held = samples[i] * norm;
    const hp = hpA * (hpPrevOut + held - hpPrevIn); // one-pole high-pass
    hpPrevIn = held; hpPrevOut = hp;
    lp = (1 - lpA) * hp + lpA * lp; // one-pole low-pass
    let v = Math.round(lp * 3 * 12) / 12; // 4-ish bit crush with gain
    v = Math.tanh(v * 2.5) * 0.55; // overdriven
    if (Math.random() < 0.0015) crackle = 0.6;
    crackle *= 0.99;
    v += Math.sin((2 * Math.PI * 50 * i) / sr) * 0.05 + (Math.random() * 2 - 1) * (0.02 + crackle * 0.3);
    out[i] = v * peak;
  }
  return out;
}
// apply every sabotage a take was hit with ('disturb' | 'crap')
export function applySabotages(samples, sr, types = []) {
  let s = samples;
  const disturb = types.filter((t) => t !== 'crap').length;
  if (types.includes('crap')) s = applyCrapMic(s, sr);
  if (disturb) s = applySabotage(s, sr, disturb);
  return s;
}
