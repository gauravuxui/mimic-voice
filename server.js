// Mimic Voice server: static files, sound-pack admin API, recordings relay and
// authoritative multiplayer rooms over WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createStore } from './store.js';
import { ROUNDS, MAX_PLAYERS, recDurFor, GAP_AFTER_DEMO, segmentsFor, autoVolley, ROUND_OPTIONS, SEG } from './public/js/shared.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'packs');
const PACKS_FILE = path.join(DATA, 'packs.json');
const PORT = Number(process.env.PORT) || 8793;
const TOTAL_ROUNDS = Number(process.env.MV_ROUNDS) || ROUNDS; // MV_ROUNDS shortens games for testing
fs.mkdirSync(MEDIA, { recursive: true });
// uploaded packs survive wiped disks by mirroring the data folder to a private GitHub repo (see store.js)
const store = createStore({ dataDir: DATA, repo: process.env.GITHUB_DATA_REPO, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
try { await store.pull(); } catch (e) { console.error(`[store] ${e.message} – continuing with the local data folder`); }

const ADMIN_KEY = process.env.ADMIN_KEY || (() => {
  const f = path.join(DATA, 'admin-key.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const k = crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(f, k);
  return k;
})();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4',
};
const uid = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);

// ---------- sound packs ----------
let customPacks = [];
try { customPacks = JSON.parse(fs.readFileSync(PACKS_FILE, 'utf8')); } catch {}
const savePacks = async () => { await fsp.writeFile(PACKS_FILE, JSON.stringify(customPacks, null, 2)); store.save('packs.json'); };
function publicPacks() {
  return [
    ...customPacks.filter((p) => p.enabled !== false && p.clips.length).map((p) => ({
      id: p.id, name: p.name, icon: p.icon, color: p.color, image: p.image ? `/media/${p.id}/${p.image}` : null,
      clips: p.clips.map((c) => ({ id: c.id, name: c.name, stars: c.stars, dur: c.dur, url: `/media/${p.id}/${c.file}` })),
    })),
  ];
}
// likes / reports from the end-of-game "What did you think of these packs?" screen
const STATS_FILE = path.join(DATA, 'pack-stats.json');
let packStats = {};
try { packStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch {}
const voted = new Set();
function packFeedback(packId, kind, voter) {
  const k = `${voter}|${packId}|${kind}`;
  if (voted.has(k)) return;
  voted.add(k);
  const st = (packStats[packId] ||= { likes: 0, reports: 0 });
  if (kind === 'like') st.likes++; else st.reports++;
  fsp.writeFile(STATS_FILE, JSON.stringify(packStats, null, 2)).then(() => store.saveLater('pack-stats.json')).catch(() => {});
}
const findClip = (key) => {
  const [pid, cid] = key.split('/');
  const pack = publicPacks().find((p) => p.id === pid);
  return pack && pack.clips.find((c) => c.id === cid);
};

// ---------- http ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function serveFile(res, file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw 0;
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}
const safeJoin = (base, rel) => {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
};

// sniff the real image type from the first bytes (never trust the upload's name or header)
function imageExt(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  return null;
}

async function handleAdmin(req, res, parts) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, 401, { error: 'wrong admin key' });
  const [, , , packId, sub, clipId] = parts; // /api/admin/packs/:id/clips/:cid
  const m = req.method;
  if (parts[3] === undefined && parts[2] === 'check') return json(res, 200, { ok: true });
  if (parts[2] === 'pack-stats' && m === 'GET') return json(res, 200, packStats);
  if (parts[2] === 'rooms' && m === 'GET') return json(res, 200, [...rooms.values()].map((r) => ({ ...snapshot(r), forceSpin: r.forceSpin ?? null })));
  if (parts[2] !== 'packs') return json(res, 404, { error: 'not found' });

  if (!packId) {
    if (m === 'GET') return json(res, 200, customPacks);
    if (m === 'POST') {
      const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
      const pack = { id: 'p' + uid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x'), name: String(b.name || 'New pack').slice(0, 40), icon: String(b.icon || '🎵').slice(0, 4), color: b.color || '#c9772f', enabled: true, clips: [] };
      customPacks.push(pack);
      await savePacks(); broadcastPacks();
      return json(res, 200, pack);
    }
  }
  const pack = customPacks.find((p) => p.id === packId);
  if (!pack) return json(res, 404, { error: 'no such pack' });

  if (!sub) {
    if (m === 'PATCH') {
      const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
      if (b.name !== undefined) pack.name = String(b.name).slice(0, 40);
      if (b.icon !== undefined) pack.icon = String(b.icon).slice(0, 4);
      if (b.color !== undefined) pack.color = String(b.color);
      if (b.enabled !== undefined) pack.enabled = !!b.enabled;
      await savePacks(); broadcastPacks();
      return json(res, 200, pack);
    }
    if (m === 'DELETE') {
      customPacks = customPacks.filter((p) => p !== pack);
      await fsp.rm(path.join(MEDIA, pack.id), { recursive: true, force: true });
      store.removeDir(`packs/${pack.id}`);
      await savePacks(); broadcastPacks();
      return json(res, 200, { ok: true });
    }
  }
  // cover image: the admin page sends an already-resized picture; a new file name per upload busts caches
  if (sub === 'image') {
    if (m === 'POST') {
      const body = await readBody(req, 3 * 1024 * 1024);
      const ext = imageExt(body);
      if (!ext) return json(res, 400, { error: 'not a png, jpeg, webp or gif image' });
      await fsp.mkdir(path.join(MEDIA, pack.id), { recursive: true });
      const file = `cover-${uid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}.${ext}`;
      await fsp.writeFile(path.join(MEDIA, pack.id, file), body);
      store.save(`packs/${pack.id}/${file}`);
      if (pack.image) { await fsp.rm(path.join(MEDIA, pack.id, pack.image), { force: true }); store.remove(`packs/${pack.id}/${pack.image}`); }
      pack.image = file;
      await savePacks(); broadcastPacks();
      return json(res, 200, pack);
    }
    if (m === 'DELETE') {
      if (pack.image) { await fsp.rm(path.join(MEDIA, pack.id, pack.image), { force: true }); store.remove(`packs/${pack.id}/${pack.image}`); }
      delete pack.image;
      await savePacks(); broadcastPacks();
      return json(res, 200, pack);
    }
  }
  if (sub === 'clips') {
    if (!clipId && m === 'POST') {
      const body = await readBody(req, 8 * 1024 * 1024);
      const id = 'c' + uid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
      const file = `${id}.wav`;
      await fsp.mkdir(path.join(MEDIA, pack.id), { recursive: true });
      await fsp.writeFile(path.join(MEDIA, pack.id, file), body);
      store.save(`packs/${pack.id}/${file}`);
      const name = decodeURIComponent(req.headers['x-clip-name'] || 'sound').slice(0, 40);
      const clip = { id, name, stars: 2, dur: Math.min(8, Math.max(0.1, Number(req.headers['x-dur']) || 1)), file };
      pack.clips.push(clip);
      await savePacks(); broadcastPacks();
      return json(res, 200, clip);
    }
    const clip = pack.clips.find((c) => c.id === clipId);
    if (!clip) return json(res, 404, { error: 'no such clip' });
    if (m === 'PATCH') {
      const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
      if (b.name !== undefined) clip.name = String(b.name).slice(0, 40);
      if (b.stars !== undefined) clip.stars = Math.min(3, Math.max(1, Number(b.stars) || 2));
      await savePacks(); broadcastPacks();
      return json(res, 200, clip);
    }
    if (m === 'DELETE') {
      pack.clips = pack.clips.filter((c) => c !== clip);
      await fsp.rm(path.join(MEDIA, pack.id, clip.file), { force: true });
      store.remove(`packs/${pack.id}/${clip.file}`);
      await savePacks(); broadcastPacks();
      return json(res, 200, { ok: true });
    }
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') {
      if (parts[1] === 'packs' && req.method === 'GET') return json(res, 200, publicPacks());
      if (parts[1] === 'rooms' && req.method === 'GET') return json(res, 200, publicRoomList());
      if (parts[1] === 'pack-feedback' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 2000)).toString() || '{}');
        if (publicPacks().some((p) => p.id === b.pack) && (b.kind === 'like' || b.kind === 'report')) packFeedback(String(b.pack), b.kind, String(b.voter || req.socket.remoteAddress).slice(0, 60));
        return json(res, 200, { ok: true });
      }
      if (parts[1] === 'admin') return await handleAdmin(req, res, parts);
      if (parts[1] === 'rec' && parts.length === 5) {
        // /api/rec/:code/:round/:pid
        const [, , code, round, pid] = parts;
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: 'no room' });
        const key = `${round}/${pid}`;
        if (req.method === 'POST') {
          if (!room.players.some((p) => p.id === pid)) return json(res, 403, { error: 'not in room' });
          room.recs.set(key, await readBody(req, 4 * 1024 * 1024));
          return json(res, 200, { ok: true });
        }
        const buf = room.recs.get(key);
        if (!buf) return json(res, 404, { error: 'no recording' });
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'cache-control': 'no-store' });
        return res.end(buf);
      }
      return json(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (parts[0] === 'media') {
      const f = safeJoin(MEDIA, parts.slice(1).join('/'));
      return f ? serveFile(res, f) : (res.writeHead(400), res.end());
    }
    let rel = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname === '/lab' ? 'lab.html' : decodeURIComponent(url.pathname.slice(1));
    const f = safeJoin(PUB, rel);
    return f ? serveFile(res, f) : (res.writeHead(400), res.end());
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

// ---------- rooms ----------
const rooms = new Map();
const sockets = new Set();
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
function broadcastPacks() {
  const packs = publicPacks();
  sockets.forEach((ws) => send(ws, { t: 'packs', packs }));
  // a pack that just went live is ticked in every open lobby (the host can still untick it)
  for (const r of rooms.values()) {
    const fresh = packs.filter((p) => !r.knownPacks.has(p.id));
    fresh.forEach((p) => r.knownPacks.add(p.id));
    if (fresh.length && r.phase === 'lobby') { r.packs.push(...fresh.map((p) => p.id)); sync(r); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
// Snapshots are made per viewer (viewer omitted = admin view with everything). Sabotage stays secret:
// only the victim's own client learns that its take must be degraded (and never by whom), and
// swap/sabotage power-ups are only shown to the player holding them. Bonus power-ups stay public.
const secretPower = (pw) => pw && (pw.kind === 'swap' || pw.kind === 'sabotage');
function snapshot(room, viewer) {
  return {
    code: room.code, hostId: room.hostId, public: !!room.public, phase: room.phase, round: room.round, rounds: room.rounds, packs: room.packs,
    players: room.players.map((p) => {
      const own = viewer === undefined || p.id === viewer;
      return {
        id: p.id, fid: p.fid || null, name: p.name, look: p.look, level: p.level, ready: p.ready, connected: p.connected, score: p.score,
        pending: own || !secretPower(p.pending) ? p.pending : null,
        active: own || !secretPower(p.active) ? p.active : null,
        sabBy: own ? (viewer === undefined ? p.sabBy : (p.sabBy || []).map(() => '?')) : [],
        sabTypes: own ? p.sabTypes || [] : [],
        held: own ? p.usedPower || null : null,
        submitted: !!p.sub, lastPts: p.lastPts, micOn: p.micOn !== false, bot: !!p.bot,
      };
    }),
  };
}
const emit = (room, msg) => room.players.forEach((p) => send(p.ws, msg));
const sync = (room) => room.players.forEach((p) => send(p.ws, { t: 'room', room: snapshot(room, p.id) }));
const live = (room) => room.players.filter((p) => p.connected);

// waits end early on `cond`, when the room dies, or when the test lab sends "skip"
async function waitFor(room, cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && room.alive && !room.skip && !cond()) await sleep(100);
  room.skip = false;
}
const nap = (room, ms) => waitFor(room, () => false, ms);

function makeDeck(room) {
  const packs = publicPacks().filter((p) => room.packs.includes(p.id));
  const pool = packs.flatMap((p) => p.clips.map((c) => ({ key: `${p.id}/${c.id}`, dur: c.dur })));
  let bag = [];
  return () => {
    if (!bag.length) bag = [...pool].sort(() => Math.random() - 0.5);
    return bag.pop();
  };
}

async function runGame(room) {
  const P = room.players;
  P.forEach((p) => Object.assign(p, { score: 0, pending: null, active: null, sabBy: [], sabTypes: [], nextSabBy: [], nextSabTypes: [], usedPower: null, sub: null, history: [], lastPts: 0 }));
  room.nextSwaps = [];
  room.endNow = false;
  room.stats = { takes: 0, best: null, packs: new Set() };
  const deal = makeDeck(room);
  for (let r = 1; r <= room.rounds && room.alive && !room.endNow; r++) {
    room.round = r;
    room.recs.clear();
    room.swaps = room.nextSwaps || [];
    room.nextSwaps = [];
    // one sound for everybody this round
    const clip = deal();
    room.clip = clip;
    room.stats.packs.add(clip.key.split('/')[0]);
    P.forEach((p) => { p.active = p.pending || p.usedPower || null; p.usedPower = null; p.pending = null; p.sabBy = p.nextSabBy || []; p.nextSabBy = []; p.sabTypes = p.nextSabTypes || []; p.nextSabTypes = []; p.sub = null; p.lastPts = 0; });
    room.phase = 'announce'; sync(room);
    await nap(room, 2300);

    P.forEach((p) => { if (p.active && (p.active.kind === 'swap' || p.active.kind === 'sabotage')) p.active = null; });

    room.phase = 'prepare'; room.loaded = new Set(); sync(room);
    emit(room, { t: 'prepare', clip: clip.key });
    await waitFor(room, () => live(room).every((p) => room.loaded.has(p.id)), 12000);

    // everyone hears the demo at the same moment, then records at the same moment
    const at = Date.now() + 1600;
    room.phase = 'listen'; sync(room);
    emit(room, { t: 'listen', at });
    const dur = clip.dur + 0.15;
    await waitFor(room, () => live(room).every((p) => p.sub), 1600 + (dur + GAP_AFTER_DEMO + recDurFor(dur)) * 1000 + 15000);
    if (!room.alive) return;

    // SWAP exchanges the recorded takes
    const takes = new Map(P.map((p) => [p.id, { sub: p.sub, recOf: p.id }]));
    for (const [a, b] of room.swaps) {
      const ta = takes.get(a), tb = takes.get(b);
      takes.set(a, tb); takes.set(b, ta);
    }

    room.phase = 'reveal'; sync(room);
    emit(room, { t: 'revealStart', recs: P.filter((p) => p.sub?.hasRec).map((p) => p.id) });
    await nap(room, 1200);
    for (const p of P) {
      if (!room.alive || room.endNow) break;
      const take = takes.get(p.id);
      const sub = take.sub || { pct: 0, note: 'missing', recDur: 0 };
      let pts = Math.max(0, Math.min(100, Math.round(sub.pct) || 0));
      if (sub.note === 'silent' || sub.note === 'missing') pts = 0;
      else if (p.active?.kind === 'add') pts += p.active.value;
      else if (p.active?.kind === 'mult') pts = Math.round(pts * 1.5);
      const sw = room.swaps.find(([a, b]) => a === p.id || b === p.id);
      const swappedWith = sw ? (sw[0] === p.id ? sw[1] : sw[0]) : null;
      // the crowd's auto-volley is decided here so every screen shows the same throws
      const others = live(room).filter((x) => x !== p);
      const volley = autoVolley(pts > 0 ? sub.pct : 0).map((item) => ({ item, from: others.length ? others[crypto.randomInt(others.length)].id : null }));
      const walk = 1.6, rec = Math.min(7, sub.recDur || 0);
      const owner = P.find((x) => x.id === take.recOf);
      emit(room, { t: 'reveal', pid: p.id, at: Date.now() + walk * 1000, clip: clip.key, sub, recOf: take.recOf, swappedWith, pts, bonus: p.active || null, volley });
      await nap(room, (walk + rec + 0.4) * 1000);
      p.score += pts; p.lastPts = pts;
      room.stats.takes++;
      if (!room.stats.best || pts > room.stats.best.pts) room.stats.best = { name: p.name, pts };
      p.history.push({ round: r, clip: clip.key, pct: sub.pct || 0, pts });
      sync(room);
      await nap(room, 4200);
    }

    // no scoreboard screen: points already landed on the cards after each reveal
    await nap(room, 1500);

    if (r < room.rounds && !room.endNow) {
      const segs = segmentsFor(P.length);
      room.phase = 'spinner'; room.spins = new Map(); sync(room);
      emit(room, { t: 'wheel', segs, deadline: Date.now() + 10000 });
      room.doSpin = (p) => {
        if (room.spins.has(p.id)) return;
        let index = crypto.randomInt(segs.length);
        if (room.forceSpin != null) {
          const f = segs.findIndex((x) => x.label === room.forceSpin);
          if (f >= 0) index = f;
          room.forceSpin = null;
        }
        room.spins.set(p.id, index);
        const seg = segs[index];
        p.pending = (seg.kind === 'swap' || seg.kind === 'sabotage') && live(room).length < 2 ? { ...SEG.p5, solo: true } : { ...seg };
        send(p.ws, { t: 'spin', pid: p.id, index });
      };
      await waitFor(room, () => live(room).every((p) => room.spins.has(p.id)), 10000);
      live(room).forEach((p) => room.doSpin(p)); // auto-spin whoever didn't
      room.doSpin = null;
      await sleep(5000); // wheel animation on every screen
      sync(room); // results land on the cards
      await nap(room, 3000);
      const choosers = live(room).filter((p) => p.pending && (p.pending.kind === 'swap' || p.pending.kind === 'sabotage'));
      if (choosers.length && P.length > 1) {
        room.choices = new Map();
        const deadline = Date.now() + 12000;
        room.players.forEach((p) => {
          const mine = choosers.find((c) => c.id === p.id);
          send(p.ws, { t: 'powerups', choosers: mine ? [{ id: mine.id, kind: mine.pending.kind, sab: mine.pending.sab || null }] : [], waiting: choosers.length - (mine ? 1 : 0), deadline });
        });
        await waitFor(room, () => choosers.every((c) => room.choices.has(c.id) || !c.connected), 12000);
        const results = [];
        for (const c of choosers) {
          const t = P.find((p) => p.id === room.choices.get(c.id));
          if (t && t !== c) {
            if (c.pending.kind === 'swap') room.nextSwaps.push([c.id, t.id]);
            else { (t.nextSabBy ||= []).push(c.name); (t.nextSabTypes ||= []).push(c.pending.sab || 'disturb'); }
            results.push({ from: c.id, to: t.id, kind: c.pending.kind, sab: c.pending.sab || null });
          }
          c.usedPower = c.pending; // shown as the held power next round
          c.pending = null;
        }
        room.choices = null;
        room.players.forEach((p) => {
          const mine = results.filter((x) => x.kind === 'swap' || x.from === p.id).map((x) => (x.kind === 'swap' && x.from !== p.id ? { from: x.from, kind: 'swap' } : x));
          if (mine.length) send(p.ws, { t: 'powerResult', results: mine });
        });
        sync(room);
        await nap(room, results.length ? 2400 : 400);
      }
    }
  }
  if (!room.alive) return;
  room.phase = 'final'; sync(room);
  const st = room.stats;
  emit(room, { t: 'final', ranking: [...P].sort((a, b) => b.score - a.score).map((p) => ({ id: p.id, score: p.score, history: p.history })), stats: { takes: st.takes, best: st.best, packs: [...st.packs] } });
  await sleep(1000);
  P.forEach((p) => { p.ready = p.id === room.hostId || !!p.bot; });
  room.phase = 'lobby'; room.round = 0;
  room.players = room.players.filter((p) => p.connected);
  sync(room);
}

function publicRoomList() {
  return [...rooms.values()]
    .filter((r) => r.public && r.alive && r.players.some((p) => p.connected))
    .map((r) => ({
      code: r.code, host: r.players.find((p) => p.id === r.hostId)?.name || '?', players: r.players.filter((p) => p.connected).length,
      max: MAX_PLAYERS, phase: r.phase, round: r.round, rounds: r.rounds,
    }))
    .sort((a, b) => (b.phase === 'lobby') - (a.phase === 'lobby') || b.players - a.players); // open lobbies first
}
function newRoom(ws, isPublic) {
  const r = { code: newCode(), hostId: ws.pid, public: !!isPublic, players: [], phase: 'lobby', round: 0, rounds: TOTAL_ROUNDS, packs: publicPacks().map((p) => p.id), knownPacks: new Set(publicPacks().map((p) => p.id)), recs: new Map(), swaps: [], chat: [], alive: true };
  rooms.set(r.code, r);
  return r;
}
function joinRoom(ws, r, asHost) {
  leaveRoom(ws);
  r.players = r.players.filter((p) => p.id !== ws.pid);
  r.players.push({ id: ws.pid, fid: ws.fid, ws, ...ws.profile, ready: asHost || !!ws.bot, connected: true, score: 0, sabBy: [], micOn: true, bot: !!ws.bot });
  ws.room = r;
  send(ws, { t: 'joined', code: r.code });
  send(ws, { t: 'chatHistory', list: (r.chat || []).filter((c) => !c.to || c.to === ws.pid || c.from === ws.pid) });
  sync(r);
}
function canJoin(r) {
  if (!r || !r.alive) return 'Room not found – check the code';
  if (r.phase !== 'lobby') return 'That game already started – wait for the next one';
  if (r.players.length >= MAX_PLAYERS) return 'Room is full';
  return null;
}
// Voice chat needs a TURN relay when players sit behind strict NATs (common on mobile/CGNAT internet).
// Cloudflare TURN (CF_TURN_KEY_ID + CF_TURN_API_TOKEN) gets short-lived credentials; a fixed TURN
// server works too (TURN_URLS comma-separated + TURN_USERNAME + TURN_CREDENTIAL). Without either: STUN only.
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let iceCache = null; // { servers, until }
async function iceServers() {
  if (iceCache && Date.now() < iceCache.until) return iceCache.servers;
  let servers = STUN, ttl = 3600e3;
  const { CF_TURN_KEY_ID: keyId, CF_TURN_API_TOKEN: apiToken, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  try {
    if (keyId && apiToken) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
      });
      if (!r.ok) throw new Error(`Cloudflare TURN answered ${r.status}`);
      const d = await r.json();
      servers = [...STUN, ...[].concat(d.iceServers || [])];
      ttl = 12 * 3600e3; // credentials live 24h, refresh well before
    } else if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
      servers = [...STUN, { urls: TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean), username: TURN_USERNAME, credential: TURN_CREDENTIAL }];
      ttl = 24 * 3600e3;
    }
  } catch (e) {
    console.error(`[turn] ${e.message} – voice chat falls back to STUN only`);
    ttl = 5 * 60e3; // try again soon
  }
  iceCache = { servers, until: Date.now() + ttl };
  return servers;
}

// friend codes -> who is online right now
const presence = new Map(); // fid -> ws
function presenceOf(fid) {
  const w = presence.get(fid);
  if (!w || w.readyState !== 1) return { fid, online: false };
  const r = w.room;
  return { fid, online: true, name: w.profile?.name, look: w.profile?.look, room: r ? r.code : null, roomPublic: !!r?.public, phase: r?.phase || null, size: r ? r.players.length : 0, max: MAX_PLAYERS, round: r?.round || 0, rounds: r?.rounds || 0 };
}
function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  const p = room.players.find((x) => x.ws === ws);
  ws.room = null;
  if (!p) return;
  if (room.phase === 'lobby') room.players = room.players.filter((x) => x !== p);
  else { p.connected = false; p.ws = null; }
  if (!room.players.some((x) => x.connected)) { room.alive = false; rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players.find((x) => x.connected).id;
  sync(room);
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'packs', packs: publicPacks() });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room;
    const me = room && room.players.find((p) => p.ws === ws);
    switch (m.t) {
      case 'ping': send(ws, { t: 'pong', c: m.c, s: Date.now() }); break;
      case 'hello': {
        ws.pid = String(m.pid || uid()).slice(0, 40);
        ws.bot = !!m.bot;
        ws.profile = { name: String(m.profile?.name || 'Player').slice(0, 16), look: m.profile?.look || {}, level: Number(m.profile?.level) || 1 };
        ws.fid = /^[A-Z0-9]{6}$/.test(String(m.profile?.fid || '')) ? m.profile.fid : null;
        if (!ws.bot) iceServers().then((servers) => send(ws, { t: 'ice', servers }));
        if (ws.fid && !ws.bot) presence.set(ws.fid, ws);
        // rejoin a running game after a reconnect
        for (const r of rooms.values()) {
          const p = r.players.find((x) => x.id === ws.pid);
          if (p) {
            p.ws = ws; p.connected = true; ws.room = r;
            send(ws, { t: 'joined', code: r.code });
            send(ws, { t: 'chatHistory', list: (r.chat || []).filter((c) => !c.to || c.to === ws.pid || c.from === ws.pid) });
            sync(r);
            break;
          }
        }
        break;
      }
      case 'profile': {
        ws.profile = { name: String(m.profile?.name || 'Player').slice(0, 16), look: m.profile?.look || {}, level: Number(m.profile?.level) || 1 };
        const fid = String(m.profile?.fid || '');
        if (/^[A-Z0-9]{6}$/.test(fid) && !ws.bot) { ws.fid = fid; presence.set(fid, ws); }
        if (me) { Object.assign(me, ws.profile, { fid: ws.fid }); sync(room); }
        break;
      }
      case 'create': {
        if (!ws.pid) return;
        joinRoom(ws, newRoom(ws, !!m.public), true);
        break;
      }
      case 'join': {
        if (!ws.pid) return;
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        const err = canJoin(r);
        if (err) return send(ws, { t: 'error', msg: err });
        joinRoom(ws, r, false);
        break;
      }
      case 'quickplay': {
        // busiest open public lobby first, otherwise open a new public room
        if (!ws.pid) return;
        const open = [...rooms.values()].filter((r) => r.public && !canJoin(r) && r !== ws.room).sort((x, y) => y.players.length - x.players.length);
        if (open.length) joinRoom(ws, open[0], false);
        else { joinRoom(ws, newRoom(ws, true), true); send(ws, { t: 'error', msg: 'No open rooms right now – you are hosting a new public one' }); }
        break;
      }
      case 'listRooms': send(ws, { t: 'rooms', list: publicRoomList() }); break;
      case 'visibility': if (me && room.hostId === me.id) { room.public = !!m.public; sync(room); } break;
      case 'kick': {
        if (!me || room.hostId !== me.id || room.phase !== 'lobby') break;
        const t = room.players.find((p) => p.id === m.pid && p !== me);
        if (!t) break;
        if (t.ws) { send(t.ws, { t: 'error', msg: 'The host removed you from the room' }); send(t.ws, { t: 'left' }); leaveRoom(t.ws); }
        else { room.players = room.players.filter((p) => p !== t); sync(room); }
        break;
      }
      // ---- friends (no accounts: everyone has a 6-letter friend code)
      case 'friendsStatus': send(ws, { t: 'friendsStatus', list: (m.fids || []).slice(0, 100).map((f) => presenceOf(String(f))) }); break;
      case 'friendAdd': {
        const st = presenceOf(String(m.fid || ''));
        send(ws, { t: 'friendInfo', ...st, found: st.online });
        if (st.online && ws.fid) send(presence.get(st.fid), { t: 'friendRequest', from: { fid: ws.fid, name: ws.profile?.name, look: ws.profile?.look } });
        break;
      }
      case 'joinReq': {
        // ask a friend to let me into their party
        const t = presence.get(String(m.fid || ''));
        if (!t || t.readyState !== 1) return send(ws, { t: 'error', msg: 'Your friend is offline' });
        if (!t.room) return send(ws, { t: 'error', msg: `${t.profile?.name || 'Your friend'} isn't in a room right now` });
        if (t.room.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Their game already started – try again after it' });
        send(t, { t: 'joinReq', from: { fid: ws.fid, name: ws.profile?.name } });
        send(ws, { t: 'error', msg: 'Request sent – waiting for them to accept' });
        break;
      }
      case 'joinReqAnswer': {
        const t = presence.get(String(m.fid || ''));
        if (!t || t.readyState !== 1) break;
        if (m.ok && room && !canJoin(room)) send(t, { t: 'joinReqResult', ok: true, code: room.code, name: ws.profile?.name });
        else send(t, { t: 'joinReqResult', ok: false, name: ws.profile?.name });
        break;
      }
      case 'fdm': {
        // direct message between friends, works outside rooms too
        const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const t = presence.get(String(m.fid || ''));
        if (!text || !ws.fid) break;
        const now = Date.now();
        if (now - (ws.lastFdm || 0) < 500) break;
        ws.lastFdm = now;
        if (!t || t.readyState !== 1) return send(ws, { t: 'error', msg: 'Your friend is offline – message not delivered' });
        const msg = { t: 'fdm', from: ws.fid, fromName: ws.profile?.name, to: t.fid, text, ts: now };
        send(t, msg); send(ws, msg);
        break;
      }
      case 'invite': {
        const t = presence.get(String(m.fid || ''));
        if (!room || !t || t.readyState !== 1) return send(ws, { t: 'error', msg: 'Your friend is offline' });
        send(t, { t: 'invite', from: { fid: ws.fid, name: ws.profile?.name }, code: room.code });
        send(ws, { t: 'error', msg: 'Invite sent!' });
        break;
      }
      case 'leave': leaveRoom(ws); send(ws, { t: 'left' }); break;
      case 'ready': if (me && room.phase === 'lobby') { me.ready = !!m.v; sync(room); } break;
      case 'packs': if (me && room.hostId === me.id && room.phase === 'lobby') { room.packs = (m.packs || []).map(String); sync(room); } break;
      case 'start': {
        if (!me || room.hostId !== me.id || room.phase !== 'lobby') return;
        const packs = publicPacks().filter((p) => room.packs.includes(p.id) && p.clips.length);
        if (!packs.length) return send(ws, { t: 'error', msg: publicPacks().length ? 'Pick at least one sound pack' : 'No sound packs yet – upload some on the /admin page' });
        if (!room.players.every((p) => p.ready)) return send(ws, { t: 'error', msg: 'Everyone has to be ready' });
        runGame(room).catch((e) => { console.error(e); room.phase = 'lobby'; sync(room); });
        break;
      }
      case 'loaded': if (me && room.loaded) room.loaded.add(me.id); break;
      case 'choice': if (me && room.choices) room.choices.set(me.id, m.target || null); break;
      case 'submit':
        if (me && room.phase === 'listen' && !me.sub) {
          const s = m.sub || {};
          me.sub = { pct: Math.max(0, Math.min(100, Number(s.pct) || 0)), pitch: +s.pitch || 0, rhythm: +s.rhythm || 0, tone: +s.tone || 0, note: s.note ? String(s.note) : undefined, recDur: Math.min(8, +s.recDur || 0), hasRec: !!s.hasRec };
          sync(room);
        }
        break;
      case 'spin': if (me && room.phase === 'spinner' && room.doSpin) room.doSpin(me); break;
      case 'settings':
        if (me && room.hostId === me.id && room.phase === 'lobby' && ROUND_OPTIONS.includes(Number(m.rounds))) { room.rounds = Number(m.rounds); sync(room); }
        break;
      case 'report': {
        const t = me && room.players.find((p) => p.id === m.pid);
        if (!t) break;
        fsp.appendFile(path.join(DATA, 'reports.log'), `${new Date().toISOString()}\troom ${room.code}\t${me.name} reported ${t.name}\t${String(m.reason || '').slice(0, 100)}\n`).then(() => store.saveLater('reports.log')).catch(() => {});
        send(ws, { t: 'error', msg: `Thanks – ${t.name} was reported` });
        break;
      }
      case 'mic': if (me) { me.micOn = !!m.on; sync(room); } break;
      case 'chat': {
        const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!me || !text) break;
        const now = Date.now();
        if (now - (me.lastChat || 0) < 600) break; // light spam guard
        me.lastChat = now;
        const msg = { from: me.id, name: me.name, text, ts: now };
        if (m.to) {
          // private message: only the two players ever see it
          const t = room.players.find((p) => p.id === String(m.to));
          if (!t || t === me) break;
          msg.to = t.id;
          send(ws, { t: 'chat', ...msg });
          send(t.ws, { t: 'chat', ...msg });
        } else emit(room, { t: 'chat', ...msg });
        room.chat.push(msg);
        if (room.chat.length > 120) room.chat.shift();
        break;
      }
      case 'rtc': {
        // WebRTC voice-chat signalling relay (offer / answer / ice) between players of one room
        const t = me && room.players.find((p) => p.id === m.to);
        if (t) send(t.ws, { t: 'rtc', from: me.id, data: m.data });
        break;
      }
      case 'dev': {
        if (m.key !== ADMIN_KEY) return send(ws, { t: 'error', msg: 'dev: wrong admin key' });
        const r = rooms.get(String(m.code || '').toUpperCase());
        if (!r) return send(ws, { t: 'error', msg: 'dev: no such room' });
        if (m.cmd === 'skip') r.skip = true;
        else if (m.cmd === 'rounds') { r.rounds = Math.max(1, Math.min(20, Number(m.arg) || ROUNDS)); sync(r); }
        else if (m.cmd === 'forceSpin') r.forceSpin = m.arg || null;
        else if (m.cmd === 'end') { r.endNow = true; r.skip = true; }
        else if (m.cmd === 'start' && r.phase === 'lobby') { r.players.forEach((p) => { p.ready = true; }); runGame(r).catch((e) => { console.error(e); r.phase = 'lobby'; sync(r); }); }
        else if (m.cmd === 'kick') {
          const p = r.players.find((x) => x.id === m.arg);
          if (p?.ws) { send(p.ws, { t: 'error', msg: 'You were removed by the test lab' }); send(p.ws, { t: 'left' }); leaveRoom(p.ws); }
          else if (p) { r.players = r.players.filter((x) => x !== p); sync(r); }
        }
        send(ws, { t: 'devOk', cmd: m.cmd });
        break;
      }
      case 'throw':
        if (me && room.phase === 'reveal' && ['bottle', 'shoe', 'stone'].includes(m.item)) {
          const now = Date.now();
          if (now - (me.lastThrow || 0) < 350) return;
          me.lastThrow = now;
          emit(room, { t: 'throw', from: me.id, to: String(m.to), item: m.item });
        }
        break;
    }
  });
  ws.on('close', () => { sockets.delete(ws); if (ws.fid && presence.get(ws.fid) === ws) presence.delete(ws.fid); leaveRoom(ws); });
});
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 20000);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    await Promise.race([store.flush(), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  });
}
server.listen(PORT, () => {
  console.log(`Mimic Voice running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin   (admin key: ${ADMIN_KEY})`);
});
