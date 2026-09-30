// Mimic scoring: compares pitch contour, rhythm (loudness envelope) and tone (MFCC)
// between the reference clip and the player's recording, aligned with DTW.

const SR = 11025, N = 512, HOP = 128, HALF = N / 2;
const TMIN = 8, TMAX = 160; // ~1378 Hz .. ~69 Hz
const NB = 26, NC = 12;

const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

const mel = (f) => 2595 * Math.log10(1 + f / 700);
const imel = (m) => 700 * (10 ** (m / 2595) - 1);
const filters = (() => {
  const lo = mel(80), hi = mel(5000);
  const pts = Array.from({ length: NB + 2 }, (_, i) => imel(lo + ((hi - lo) * i) / (NB + 1)) / (SR / N));
  return Array.from({ length: NB }, (_, b) => {
    const w = new Float32Array(HALF + 1);
    for (let k = 0; k <= HALF; k++) {
      if (k >= pts[b] && k <= pts[b + 1]) w[k] = (k - pts[b]) / (pts[b + 1] - pts[b]);
      else if (k > pts[b + 1] && k <= pts[b + 2]) w[k] = (pts[b + 2] - k) / (pts[b + 2] - pts[b + 1]);
    }
    return w;
  });
})();
const dctM = Array.from({ length: NC }, (_, k) => Float32Array.from({ length: NB }, (_, b) => Math.cos((Math.PI * (k + 1) * (b + 0.5)) / NB)));

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const nsdf = new Float32Array(TMAX + 2);
function pitchOf(fr) {
  let gmax = 0;
  for (let tau = TMIN - 1; tau <= TMAX + 1; tau++) {
    let acf = 0, m = 0;
    for (let i = 0; i < N - tau; i++) { const a = fr[i], b = fr[i + tau]; acf += a * b; m += a * a + b * b; }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    if (tau >= TMIN && tau <= TMAX && nsdf[tau] > gmax) gmax = nsdf[tau];
  }
  if (gmax < 0.5) return [0, 0];
  for (let tau = TMIN; tau <= TMAX; tau++) {
    const v = nsdf[tau];
    if (v >= 0.9 * gmax && v >= nsdf[tau - 1] && v >= nsdf[tau + 1]) {
      const a = nsdf[tau - 1], c = nsdf[tau + 1], den = a - 2 * v + c;
      const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
      return [SR / (tau + shift), v];
    }
  }
  return [0, 0];
}

export async function toAnalysisRate(buffer) {
  const len = Math.max(N * 2, Math.ceil(buffer.duration * SR));
  const oc = new OfflineAudioContext(1, len, SR);
  const s = oc.createBufferSource();
  s.buffer = buffer; s.connect(oc.destination); s.start();
  return (await oc.startRendering()).getChannelData(0);
}

export function features(input) {
  let rawPeak = 0;
  for (let i = 0; i < input.length; i++) rawPeak = Math.max(rawPeak, Math.abs(input[i]));
  if (rawPeak < 1e-4) return null;
  const x = new Float32Array(Math.max(input.length, N));
  for (let i = 0; i < input.length; i++) x[i] = input[i] / rawPeak;

  const F = Math.floor((x.length - N) / HOP) + 1;
  const db = new Float32Array(F), f0 = new Float32Array(F), clar = new Float32Array(F);
  const mf = [];
  const re = new Float64Array(N), im = new Float64Array(N), melE = new Float32Array(NB);
  for (let f = 0; f < F; f++) {
    const fr = x.subarray(f * HOP, f * HOP + N);
    let s = 0;
    for (let i = 0; i < N; i++) s += fr[i] * fr[i];
    db[f] = 10 * Math.log10(s / N + 1e-10);
    [f0[f], clar[f]] = pitchOf(fr);
    for (let i = 0; i < N; i++) { re[i] = fr[i] * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < NB; b++) {
      const w = filters[b];
      let e = 0;
      for (let k = 0; k <= HALF; k++) if (w[k]) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      melE[b] = Math.log(e + 1e-8);
    }
    const c = new Float32Array(NC);
    let norm = 0;
    for (let k = 0; k < NC; k++) {
      let v = 0;
      for (let b = 0; b < NB; b++) v += melE[b] * dctM[k][b];
      c[k] = v; norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < NC; k++) c[k] /= norm;
    mf.push(c);
  }

  let peakDb = -Infinity;
  for (let f = 0; f < F; f++) peakDb = Math.max(peakDb, db[f]);
  const envAll = Float32Array.from(db, (v) => Math.min(1, Math.max(0, (v - peakDb + 40) / 40)));
  let a = 0, b = F - 1;
  while (a < F && envAll[a] < 0.3) a++;
  while (b > a && envAll[b] < 0.3) b--;
  a = Math.max(0, a - 1); b = Math.min(F - 1, b + 1);
  const n = b - a + 1;

  const env = envAll.slice(a, b + 1);
  // linear-amplitude envelope (lightly smoothed) shows syllables/gaps much more clearly than dB
  const peakLin = 10 ** (peakDb / 20);
  const envLin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -1; k <= 1; k++) { const f = a + i + k; if (f >= 0 && f < F) { s += 10 ** (db[f] / 20); c++; } }
    envLin[i] = s / c / peakLin;
  }
  let syl = 0, low = true;
  for (let i = 0; i < n; i++) {
    if (low && envLin[i] > 0.4) { syl++; low = false; }
    else if (!low && envLin[i] < 0.15) low = true;
  }
  const voiced = new Uint8Array(n), rel = new Float32Array(n).fill(NaN);
  const semis = [];
  for (let i = 0; i < n; i++) {
    const f = a + i;
    if (clar[f] > 0.6 && envAll[f] > 0.35 && f0[f] > 0) {
      voiced[i] = 1;
      rel[i] = 12 * Math.log2(f0[f] / 440);
      semis.push(rel[i]);
    }
  }
  semis.sort((p, q) => p - q);
  const med = semis.length ? semis[semis.length >> 1] : 0;
  for (let i = 0; i < n; i++) if (voiced[i]) rel[i] -= med;

  return { n, env, envLin, syl, voiced, rel, med, mfcc: mf.slice(a, b + 1), voicedRatio: semis.length / Math.max(1, n), rawPeak, dur: (n * HOP) / SR };
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const fold = (d) => d - 12 * Math.round(d / 12);
const cos = (p, q) => { let s = 0; for (let k = 0; k < NC; k++) s += p[k] * q[k]; return s; };

function resampleArr(arr, len) {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = (i / (len - 1)) * (arr.length - 1), i0 = Math.floor(t), i1 = Math.min(arr.length - 1, i0 + 1);
    out[i] = arr[i0] + (arr[i1] - arr[i0]) * (t - i0);
  }
  return out;
}
function pearson(p, q) {
  let mp = 0, mq = 0;
  for (let i = 0; i < p.length; i++) { mp += p[i]; mq += q[i]; }
  mp /= p.length; mq /= q.length;
  let sp = 0, sq = 0, spq = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i] - mp, b = q[i] - mq; sp += a * a; sq += b * b; spq += a * b; }
  return { r: sp > 0 && sq > 0 ? spq / Math.sqrt(sp * sq) : 0, stdP: Math.sqrt(sp / p.length) };
}
// fill unvoiced gaps by linear interpolation so contours can be compared
function fillContour(rel) {
  const out = Float32Array.from(rel);
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i])) {
      if (last === -1) for (let k = 0; k < i; k++) out[k] = out[i];
      else for (let k = last + 1; k < i; k++) out[k] = out[last] + ((out[i] - out[last]) * (k - last)) / (i - last);
      last = i;
    }
  }
  if (last === -1) return null;
  for (let k = last + 1; k < out.length; k++) out[k] = out[last];
  return out;
}

function dtw(A, B) {
  const n = A.n, m = B.n;
  const w = Math.max(Math.ceil(0.35 * Math.max(n, m)), Math.abs(n - m) + 3);
  const D = new Float32Array(n * m).fill(Infinity);
  const cost = (i, j) => {
    let c = Math.abs(A.env[i] - B.env[j]);
    if (A.voiced[i] && B.voiced[j]) c += (0.8 * Math.min(Math.abs(fold(A.rel[i] - B.rel[j])), 6)) / 6;
    else if (A.voiced[i] !== B.voiced[j]) c += 0.35;
    c += (0.5 * (1 - cos(A.mfcc[i], B.mfcc[j]))) / 2;
    return c;
  };
  for (let i = 0; i < n; i++) {
    const jc = Math.round((i * (m - 1)) / Math.max(1, n - 1));
    for (let j = Math.max(0, jc - w); j <= Math.min(m - 1, jc + w); j++) {
      let best;
      if (i === 0 && j === 0) best = 0;
      else best = Math.min(i > 0 ? D[(i - 1) * m + j] : Infinity, j > 0 ? D[i * m + j - 1] : Infinity, i > 0 && j > 0 ? D[(i - 1) * m + j - 1] : Infinity);
      D[i * m + j] = cost(i, j) + best;
    }
  }
  const path = [];
  let i = n - 1, j = m - 1;
  while (i > 0 || j > 0) {
    path.push([i, j]);
    const d = i > 0 && j > 0 ? D[(i - 1) * m + j - 1] : Infinity;
    const u = i > 0 ? D[(i - 1) * m + j] : Infinity;
    const l = j > 0 ? D[i * m + j - 1] : Infinity;
    if (d <= u && d <= l) { i--; j--; } else if (u <= l) i--; else j--;
  }
  path.push([0, 0]);
  return path.reverse();
}

export function compare(A, B) {
  if (!A) return { pct: 0, pitch: 0, rhythm: 0, tone: 0, dur: 0, note: 'no-ref' };
  if (!B || B.rawPeak < 0.015 || B.n < 4) return { pct: 0, pitch: 0, rhythm: 0, tone: 0, dur: 0, note: 'silent' };

  const path = dtw(A, B);
  let pitchSum = 0, pitchCnt = 0, toneSum = 0, envDiff = 0;
  for (const [i, j] of path) {
    toneSum += cos(A.mfcc[i], B.mfcc[j]);
    envDiff += Math.abs(A.env[i] - B.env[j]);
    if (A.voiced[i]) {
      pitchCnt++;
      if (B.voiced[j]) { const d = fold(A.rel[i] - B.rel[j]); pitchSum += Math.exp(-((d / 2.5) ** 2)); }
    }
  }
  const L = path.length;

  // pitch: aligned contour match (+ global contour shape when the reference moves)
  let pitch = pitchCnt ? pitchSum / pitchCnt : 0;
  const ca = fillContour(A.rel), cb = fillContour(B.rel);
  if (ca && cb) {
    const { r, stdP } = pearson(resampleArr(ca, 64), resampleArr(cb, 64));
    if (stdP > 1) pitch = 0.65 * pitch + 0.35 * clamp(r);
  }

  // rhythm: DTW envelope agreement + linear-time envelope shape
  const envSim = clamp((1 - envDiff / L - 0.6) / 0.35);
  const sylSim = 1 - Math.abs(A.syl - B.syl) / Math.max(A.syl, B.syl, 1);
  const ea = resampleArr(A.envLin, 64), eb = resampleArr(B.envLin, 64);
  const pr = pearson(ea, eb);
  let lin;
  if (pr.stdP < 0.08) { let d = 0; for (let i = 0; i < 64; i++) d += Math.abs(ea[i] - eb[i]); lin = clamp(1 - d / 64 / 0.4); }
  else lin = clamp((pr.r - 0.1) / 0.75);
  const rhythm = 0.4 * sylSim ** 1.5 + 0.4 * lin + 0.2 * envSim;

  const tone = clamp((toneSum / L - 0.35) / 0.55);
  const ratio = Math.min(A.n, B.n) / Math.max(A.n, B.n);
  const dur = clamp((ratio - 0.3) / 0.55);

  const vr = clamp((A.voicedRatio - 0.15) / 0.35);
  const wP = 0.1 + 0.42 * vr, wR = 0.5 - 0.12 * vr, wT = 0.25 - 0.18 * vr, wD = 0.15 - 0.1 * vr;
  const total = (wP * pitch + wR * rhythm + wT * tone + wD * dur) / (wP + wR + wT + wD);

  const pct = Math.round(100 * clamp((total - 0.28) / (0.86 - 0.28)) ** 0.9);
  return { pct, pitch, rhythm, tone, dur, total, sylA: A.syl, sylB: B.syl };
}

export async function scoreMimic(refBuffer, recBuffer) {
  const [a, b] = await Promise.all([toAnalysisRate(refBuffer), toAnalysisRate(recBuffer)]);
  return compare(features(a), features(b));
}

// Did the player actually make a sound? Compares the take against the mic's own noise floor,
// measured in the quiet second between the demo and the recording.
export function voiceActivity(samples, sr, noise) {
  const win = Math.max(1, Math.round(sr * 0.02));
  const rms = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); };
  let floor = 0.002;
  if (noise && noise.length > win) {
    const fr = [];
    for (let i = 0; i + win <= noise.length; i += win) fr.push(rms(noise, i, i + win));
    fr.sort((a, b) => a - b);
    floor = Math.max(floor, fr[Math.floor(fr.length * 0.5)]);
  }
  const thr = Math.max(floor * 4, 0.008);
  let active = 0, peak = 0, first = -1, last = -1;
  for (let i = 0, k = 0; i + win <= samples.length; i += win, k++) {
    const v = rms(samples, i, i + win);
    if (v > peak) peak = v;
    if (v > thr) { active++; if (first < 0) first = i; last = i + win; }
  }
  const activeSec = active * 0.02;
  const speech = activeSec >= 0.15 && peak >= Math.max(floor * 8, 0.012);
  // cut to the voiced part (+ a little air) so room noise doesn't leak into the score
  const pad = Math.round(sr * 0.12);
  const trimmed = speech ? samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad)) : samples;
  return { speech, activeSec, floor, peak, trimmed };
}
