// Voice clean-up for recorded takes, run in the browser before a take is played to the room.
// 1) Spectral noise reduction: the room's own noise – recorded during the 3-2-1 while the player waits
//    silently – is subtracted bin by bin. Removes steady background: fans, AC, hum, hiss, traffic rumble.
// 2) Voice polish: rumble cut, less mud, a little presence, gentle compression, then level the loudness.
// Scoring still uses the raw take; this only changes what everyone hears.
import { fft } from './analyze.js';

const N = 1024, HOP = 256; // ~21 ms frames, 75% overlap
const BINS = N / 2 + 1;
const ALPHA = 1.8; // over-subtraction: take away a bit more than the measured noise
const FLOOR = 0.06; // never cut a bin below -24 dB (keeps it natural, avoids "underwater" artefacts)
const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); };

function frameMags(sig) {
  const re = new Float64Array(N), im = new Float64Array(N), out = [];
  for (let s = 0; s + N <= sig.length; s += HOP) {
    for (let i = 0; i < N; i++) { re[i] = sig[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const m = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) m[k] = Math.hypot(re[k], im[k]);
    out.push(m);
  }
  return out;
}

// per-bin noise level: the median over the noise frames, so the short countdown beeps don't count as noise
function noiseProfile(x, sr, noise) {
  let frames = noise && noise.length >= sr * 0.3 ? frameMags(noise) : [];
  if (frames.length < 4) {
    // no usable noise sample: fall back to the quietest 15% of the take itself
    const all = frameMags(x);
    const quiet = all.map((m, i) => [m.reduce((a, v) => a + v * v, 0), i]).sort((a, b) => a[0] - b[0]);
    frames = quiet.slice(0, Math.max(3, Math.floor(all.length * 0.15))).map(([, i]) => all[i]);
  }
  const prof = new Float32Array(BINS), col = new Float32Array(frames.length);
  for (let k = 0; k < BINS; k++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f][k];
    col.sort();
    prof[k] = col[Math.floor(col.length / 2)];
  }
  return prof;
}

export function denoise(x, sr, noise) {
  if (x.length < N) return x;
  // if the "noise" is nearly as loud as the take (they talked during the countdown), don't trust it
  if (noise && noise.length && rms(noise) > 0.5 * rms(x)) noise = null;
  const prof = noiseProfile(x, sr, noise);
  const re = new Float64Array(N), im = new Float64Array(N);
  const acc = new Float32Array(x.length);
  const prevG = new Float32Array(BINS).fill(1);
  for (let s = -(N - HOP); s < x.length; s += HOP) {
    for (let i = 0; i < N; i++) { const j = s + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < BINS; k++) {
      const mag = Math.hypot(re[k], im[k]) + 1e-12;
      let g = Math.max(FLOOR, 1 - (ALPHA * prof[k]) / mag);
      g = 0.6 * g + 0.4 * prevG[k]; // smooth over time so leftover noise doesn't warble ("musical noise")
      prevG[k] = g;
      re[k] *= g; im[k] *= g;
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
  const presence = node('peaking', 3200, 0.9, 3); // makes words easier to follow
  const comp = oc.createDynamicsCompressor();
  comp.threshold.value = -26; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.18;
  src.connect(rumble).connect(mud).connect(presence).connect(comp).connect(oc.destination);
  src.start();
  const out = (await oc.startRendering()).getChannelData(0);
  // level it: loudest moment to about -2 dBFS, but never boost more than 12× (quiet mics, not room noise)
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? Math.min(12, 0.8 / peak) : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

export async function cleanVoice(x, sr, noise) {
  return polish(denoise(x, sr, noise), sr);
}
