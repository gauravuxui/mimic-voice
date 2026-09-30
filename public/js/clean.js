// Voice clean-up for recorded takes, run in the browser before a take is played to the room.
// 1) Noise reduction: the room's own noise – recorded during the 3-2-1 while the player waits silently –
//    is estimated per frequency, and each frame is filtered with a decision-directed Wiener gain
//    (the classic low-artefact rule: no chirpy "musical noise"). Frames where nobody is speaking get one
//    even gain across all frequencies, so what little noise remains sounds like quiet, natural room hiss.
// 2) Voice polish: rumble cut, less mud, a little presence, light compression, speech-based levelling.
// Scoring still uses the raw take; this only changes what everyone hears.
import { fft } from './analyze.js';

const N = 1024, HOP = 256; // ~21 ms frames at 48 kHz, 75% overlap
const BINS = N / 2 + 1;
const FLOOR = 0.12; // strongest cut, about -18 dB: deep enough to hide the noise, gentle enough to sound natural
const DD = 0.98; // decision-directed smoothing of the a-priori SNR (higher = fewer artefacts)
const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); };

function framePowers(sig) {
  const re = new Float64Array(N), im = new Float64Array(N), out = [];
  for (let s = 0; s + N <= sig.length; s += HOP) {
    for (let i = 0; i < N; i++) { re[i] = sig[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const p = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    out.push(p);
  }
  return out;
}

// noise power per bin. The median ignores short events (the countdown beeps); for noise-like
// signals the median of |X|² is ln2 × the mean, so divide it back out.
function noisePower(x, sr, noise) {
  let frames = noise && noise.length >= sr * 0.3 ? framePowers(noise) : [];
  if (frames.length < 4) {
    // no usable noise sample: use the quietest 15% of the take itself
    const all = framePowers(x);
    const quiet = all.map((p, i) => [p.reduce((a, v) => a + v, 0), i]).sort((a, b) => a[0] - b[0]);
    frames = quiet.slice(0, Math.max(3, Math.floor(all.length * 0.15))).map(([, i]) => all[i]);
  }
  const lam = new Float32Array(BINS), col = new Float32Array(frames.length);
  for (let k = 0; k < BINS; k++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f][k];
    col.sort();
    lam[k] = Math.max(1e-12, col[Math.floor(col.length / 2)] / Math.LN2);
  }
  return lam;
}

export function denoise(x, sr, noise) {
  if (x.length < N) return x;
  // if the "noise" is nearly as loud as the take (they talked during the countdown), don't trust it
  if (noise && noise.length && rms(noise) > 0.5 * rms(x)) noise = null;
  const lam = noisePower(x, sr, noise);
  const kLo = Math.max(1, Math.round((300 * N) / sr)), kHi = Math.min(BINS - 1, Math.round((4000 * N) / sr)); // voice band
  const re = new Float64Array(N), im = new Float64Array(N);
  const acc = new Float32Array(x.length);
  const prevS = new Float32Array(BINS); // clean-speech power estimate of the previous frame
  const g = new Float32Array(BINS), gs = new Float32Array(BINS);
  let presence = 0; // 0 = nobody talking … 1 = speech, smoothed over frames
  for (let s = -(N - HOP); s < x.length; s += HOP) {
    for (let i = 0; i < N; i++) { const j = s + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    let voiceSnr = 0;
    for (let k = 0; k < BINS; k++) {
      const P = re[k] * re[k] + im[k] * im[k];
      const post = P / lam[k]; // a-posteriori SNR
      const prio = Math.max(0.003, DD * (prevS[k] / lam[k]) + (1 - DD) * Math.max(post - 1, 0)); // a-priori SNR
      g[k] = prio / (1 + prio); // Wiener gain
      prevS[k] = g[k] * g[k] * P;
      if (k >= kLo && k <= kHi) voiceSnr += post;
    }
    // is anyone speaking in this frame? (voice band clearly above the noise, ~+4 dB)
    const speaking = voiceSnr / (kHi - kLo + 1) > 2.5;
    presence += ((speaking ? 1 : 0) - presence) * (speaking ? 0.6 : 0.12); // open fast, close slowly
    // smooth gains across neighbouring bins (no lone surviving tones), then blend towards one even gain
    // when nobody is talking
    for (let k = 0; k < BINS; k++) gs[k] = (g[Math.max(0, k - 1)] + 2 * g[k] + g[Math.min(BINS - 1, k + 1)]) / 4;
    for (let k = 0; k < BINS; k++) {
      const gk = FLOOR + (Math.max(FLOOR, gs[k]) - FLOOR) * presence;
      re[k] *= gk; im[k] *= gk;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    for (let i = 0; i < N; i++) im[i] = -im[i]; // inverse FFT through the conjugate
    fft(re, im);
    for (let i = 0; i < N; i++) { const j = s + i; if (j >= 0 && j < x.length) acc[j] += (re[i] / N) * win[i]; }
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= 1.5; // Hann × Hann at 75% overlap sums to 1.5
  return acc;
}

export async function polish(x, sr) {
  if (!x.length) return x;
  const oc = new OfflineAudioContext(1, x.length, sr);
  const buf = oc.createBuffer(1, x.length, sr);
  buf.copyToChannel(x, 0);
  const src = oc.createBufferSource();
  src.buffer = buf;
  const node = (type, f, q, gain = 0) => { const b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };
  const rumble = node('highpass', 85, 0.7); // desk thumps, mic handling, traffic
  const mud = node('peaking', 300, 1, -2); // boxy room sound
  const presence = node('peaking', 3200, 0.9, 2.5); // makes words easier to follow
  const comp = oc.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 2.5; comp.attack.value = 0.005; comp.release.value = 0.2;
  src.connect(rumble).connect(mud).connect(presence).connect(comp).connect(oc.destination);
  src.start();
  const out = (await oc.startRendering()).getChannelData(0);
  // level by the speech, not the loudest click: loudest 30% of 20 ms blocks to about -18 dBFS,
  // at most 4× louder (so a quiet room never gets turned into a loud one), peaks kept under -1 dBFS
  const blk = Math.round(sr * 0.02), levels = [];
  for (let s = 0; s + blk <= out.length; s += blk) { let e = 0; for (let i = s; i < s + blk; i++) e += out[i] * out[i]; levels.push(e / blk); }
  levels.sort((a, b) => b - a);
  const top = levels.slice(0, Math.max(1, Math.round(levels.length * 0.3)));
  const speechRms = Math.sqrt(top.reduce((a, v) => a + v, 0) / top.length);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  let gain = speechRms > 0 ? Math.min(4, 0.125 / speechRms) : 1;
  if (peak * gain > 0.9) gain = 0.9 / peak;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

export async function cleanVoice(x, sr, noise) {
  return polish(denoise(x, sr, noise), sr);
}
