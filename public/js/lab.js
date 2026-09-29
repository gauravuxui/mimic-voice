// Test Lab: bot players that really record + score, live room control, and a scoring playground.
import * as A from './audio.js';
import { scoreMimic, voiceActivity } from './analyze.js';
import { recDurFor, GAP_AFTER_DEMO, randomLook, SEGMENTS, THROWABLES } from './shared.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

let key = localStorage.getItem('mv_admin') || '';
let packs = [];
const bots = [];
const SKILLS = { great: 'Great mimic', ok: 'Okay-ish', bad: 'Bad (off pitch/speed)', wrong: 'Wrong sound', silent: 'Silent', random: 'Random each round' };
const BOT_NAMES = ['Robo Raju', 'Beep Bhai', 'Tin Tina', 'Chip Chacha', 'Bolt Bunty', 'Pixel Pinky', 'Nano Neha', 'Gear Gopal'];

let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function log(msg) {
  const el = $('#log');
  if (!el) return;
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.append(d);
  el.scrollTop = el.scrollHeight;
}

// ---------- control socket for dev commands ----------
let ctl;
function openCtl() {
  ctl = new WebSocket(wsUrl());
  ctl.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'packs') { packs = m.packs; fillClipSelect(); }
    if (m.t === 'error') toast(m.msg, 3000);
    if (m.t === 'devOk') log(`dev: ${m.cmd} ok`);
  };
  ctl.onclose = () => setTimeout(openCtl, 1500);
}
const dev = (code, cmd, arg) => { ctl.send(JSON.stringify({ t: 'dev', key, code, cmd, arg })); };

// ---------- bots ----------
// A bot is a full game client: it joins over its own WebSocket, "sings" a synthesized
// take during the real recording window, scores it with the real analyzer, uploads the
// recording, spins, uses power-ups and throws things at bad performers.
async function stretch(buf, rate) {
  const oc = new OfflineAudioContext(1, Math.ceil((buf.duration / rate) * 44100) + 1, 44100);
  const s = oc.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.connect(oc.destination); s.start();
  return oc.startRendering();
}
async function makeTake(demo, skill, recDur) {
  const sr = 44100;
  const out = new Float32Array(Math.round(recDur * sr));
  const noise = (amp) => { for (let i = 0; i < out.length; i++) out[i] += (Math.random() * 2 - 1) * amp; };
  if (skill === 'silent') { noise(0.003); return out; }
  let voiced;
  if (skill === 'wrong') voiced = await A.renderClip(pick(Object.values(A.SYNTH)), { voice: true, p: 0.7 });
  else voiced = await stretch(demo, skill === 'great' ? 0.92 : skill === 'ok' ? 0.75 : 1.7);
  const d = voiced.getChannelData(0);
  const off = Math.round(sr * 0.15);
  for (let i = 0; i < d.length && off + i < out.length; i++) out[off + i] = d[i] * 0.5;
  noise(skill === 'bad' ? 0.02 : 0.003);
  return out;
}

class Bot {
  constructor(name, skill, throws) {
    Object.assign(this, { name, skill, throws, pid: 'bot-' + crypto.randomUUID().slice(0, 8), offset: 0, bestRtt: Infinity, packs: [], room: null, code: null, status: 'connecting' });
    this.ws = new WebSocket(wsUrl());
    this.ws.onopen = () => {
      this.send({ t: 'hello', pid: this.pid, bot: true, profile: { name, look: randomLook(), level: 1 + Math.floor(Math.random() * 5) } });
      for (let i = 0; i < 5; i++) setTimeout(() => this.send({ t: 'ping', c: Date.now() }), i * 120);
      this.status = 'online';
      this._res && this._res();
    };
    this.opened = new Promise((res) => { this._res = res; });
    this.ws.onmessage = (e) => this.handle(JSON.parse(e.data)).catch((err) => log(`${this.name}: ${err.message}`));
    this.ws.onclose = () => { this.status = 'offline'; renderBots(); };
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  now() { return Date.now() + this.offset; }
  me() { return this.room?.players.find((p) => p.id === this.pid); }
  async handle(m) {
    switch (m.t) {
      case 'pong': { const rtt = Date.now() - m.c; if (rtt < this.bestRtt) { this.bestRtt = rtt; this.offset = m.s - (m.c + rtt / 2); } break; }
      case 'packs': this.packs = m.packs; break;
      case 'joined':
        this.code = m.code; this.status = `in ${m.code}`; log(`${this.name} joined ${m.code}`); renderBots();
        setTimeout(() => this.send({ t: 'chat', text: pick(['hi! 🤖', 'ready to lose? 😎', 'beep boop, lets go', 'namaste 🙏']) }), 800 + Math.random() * 1500);
        break;
      case 'error': log(`${this.name}: ${m.msg}`); break;
      case 'left': this.status = 'left'; renderBots(); break;
      case 'room': {
        this.room = m.room;
        const me = this.me();
        if (m.room.phase === 'lobby' && me && !me.ready) this.send({ t: 'ready', v: true });
        break;
      }
      case 'prepare': {
        this.clip = m.clip;
        await A.getClip(m.clip, this.packs).catch(() => {});
        this.send({ t: 'loaded' });
        break;
      }
      case 'listen': await this.take(m.at); break;
      case 'powerups': {
        const mine = m.choosers.find((c) => c.id === this.pid);
        if (!mine) break;
        await sleep(1500);
        const others = this.room.players.filter((p) => p.id !== this.pid && p.connected);
        const t = others.length ? pick(others) : null;
        this.send({ t: 'choice', target: t?.id || null });
        log(`${this.name} used ${mine.kind} on ${t?.name || 'nobody'}`);
        break;
      }
      case 'wheel': this.lastSegs = m.segs; await sleep(800 + Math.random() * 2500); this.send({ t: 'spin' }); break;
      case 'spin': if (m.pid === this.pid) log(`${this.name} spun ${this.lastSegs?.[m.index]?.label || m.index}`); break;
      case 'reveal': {
        if (!this.throws || m.pid === this.pid || (m.sub?.pct ?? 0) >= 50) break;
        const demoDur = (await A.getClip(m.clip, this.packs).catch(() => null))?.duration || 1;
        const when = m.at + (demoDur + 0.6 + (m.sub?.recDur || 0) + 1.2) * 1000 - this.now();
        await sleep(Math.max(0, when));
        const n = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < n; i++) { this.send({ t: 'throw', to: m.pid, item: pick(THROWABLES).kind }); await sleep(420); }
        break;
      }
    }
  }
  async take(at) {
    const demo = await A.getClip(this.clip, this.packs);
    const dur = demo.duration, recDur = recDurFor(dur);
    const skill = this.skill === 'random' ? pick(['great', 'ok', 'bad', 'wrong', 'silent']) : this.skill;
    let samples = await makeTake(demo, skill, recDur);
    await sleep(Math.max(0, at + (dur + GAP_AFTER_DEMO + recDur) * 1000 + 400 - this.now()));
    const sr = 44100;
    const va = voiceActivity(samples, sr, new Float32Array(sr * 0.5).map(() => (Math.random() * 2 - 1) * 0.003));
    const sab = this.me()?.sabBy?.length || 0;
    const sabTypes = this.me()?.sabTypes || [];
    let res;
    if (!va.speech) res = { pct: 0, pitch: 0, rhythm: 0, tone: 0, note: 'silent' };
    else {
      res = await scoreMimic(demo, A.toBuffer(sab ? A.applySabotages(va.trimmed, sr, sabTypes) : va.trimmed, sr));
      if (sab) res.pct = Math.max(res.pct, Math.round((await scoreMimic(demo, A.toBuffer(va.trimmed, sr))).pct * 0.45));
    }
    if (sab) samples = A.applySabotages(samples, sr, sabTypes);
    let hasRec = false;
    try {
      const wav = await A.encodeWav(samples, sr);
      hasRec = (await fetch(`/api/rec/${this.room.code}/${this.room.round}/${this.pid}`, { method: 'POST', body: wav })).ok;
    } catch {}
    this.send({ t: 'submit', sub: { pct: res.pct, pitch: res.pitch, rhythm: res.rhythm, tone: res.tone, note: res.note, recDur: samples.length / sr, hasRec } });
    log(`${this.name} [${skill}${sab ? ', jammed' : ''}] → ${res.note === 'silent' ? 'silent (0)' : res.pct + '%'}`);
  }
  async create() { await this.opened; this.send({ t: 'create' }); }
  async join(code) { await this.opened; this.send({ t: 'join', code }); }
  leave() { this.send({ t: 'leave' }); this.ws.close(); }
}
function newBot(skill, throws) {
  const b = new Bot(BOT_NAMES[bots.length % BOT_NAMES.length] + (bots.length >= BOT_NAMES.length ? ` ${bots.length}` : ''), skill, throws);
  bots.push(b);
  return b;
}
function renderBots() {
  const el = $('#botList');
  if (!el) return;
  el.replaceChildren();
  if (!bots.length) el.append(h(`<div class="muted">No bots running.</div>`));
  bots.forEach((b, i) => {
    const row = h(`<div class="pl"><span>🤖</span><b>${esc(b.name)}</b><span class="pill">${esc(b.skill)}</span><span class="muted">${esc(b.status)}</span><button title="Remove bot">✕</button></div>`);
    $('button', row).onclick = () => { b.leave(); bots.splice(i, 1); renderBots(); };
    el.append(row);
  });
}

// ---------- rooms panel ----------
async function pollRooms() {
  try {
    const r = await fetch('/api/admin/rooms', { headers: { 'x-admin-key': key } });
    if (r.ok) renderRooms(await r.json());
  } catch {}
  setTimeout(pollRooms, 1500);
}
function renderRooms(rooms) {
  const el = $('#rooms');
  if (!el || el.contains(document.activeElement)) return; // don't fight the user's typing
  el.replaceChildren();
  if (!rooms.length) el.append(h(`<div class="muted">No rooms right now. Create a test room above, or create one in the game.</div>`));
  rooms.forEach((room) => {
    const card = h(`<div class="room">
      <div class="room-head">
        <span class="code">${room.code}</span><span class="phase">${esc(room.phase)}</span>
        <span class="muted">round ${room.round}/${room.rounds} · ${room.players.length} players${room.forceSpin ? ` · next spin: ${esc(room.forceSpin)}` : ''}</span>
        <a href="/?room=${room.code}" target="_blank" class="btn small" style="margin-left:auto">🎮 OPEN AS PLAYER ↗</a>
      </div>
      <div class="plist"></div>
      <div class="ctl">
        <select class="skill">${Object.entries(SKILLS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button class="btn small" data-a="bot">🤖 + BOT</button>
        <button class="btn small green" data-a="start">▶ FORCE START</button>
        <button class="btn small yellow" data-a="skip">⏭ SKIP PHASE</button>
        <button class="btn small pink" data-a="end">⏹ END GAME</button>
      </div>
      <div class="ctl">
        <span class="muted">Rounds</span><input type="number" class="rounds" min="1" max="20" value="${room.rounds}" /><button class="btn small ghost" data-a="rounds">SET</button>
        <span class="muted" style="margin-left:10px">Next spin</span>
        <select class="spin"><option value="">random</option>${[...new Set(SEGMENTS.map((s) => s.label))].map((l) => `<option ${room.forceSpin === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <button class="btn small ghost" data-a="spin">SET</button>
      </div>
    </div>`);
    room.players.forEach((p) => {
      const row = h(`<div class="pl"><span>${p.bot ? '🤖' : p.micOn ? '🎙️' : '🔇'}</span><b>${p.id === room.hostId ? '👑 ' : ''}${esc(p.name)}</b><span class="sc">${p.score}</span>${p.connected ? '' : '<span class="muted">offline</span>'}<button title="Kick">✕</button></div>`);
      $('button', row).onclick = () => dev(room.code, 'kick', p.id);
      $('.plist', card).append(row);
    });
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'bot') { if (room.phase !== 'lobby') return toast('Bots can only join in the lobby'); newBot($('.skill', card).value, $('#botThrow').checked).join(room.code); renderBots(); }
      else if (a === 'rounds') dev(room.code, 'rounds', +$('.rounds', card).value);
      else if (a === 'spin') dev(room.code, 'forceSpin', $('.spin', card).value || null);
      else dev(room.code, a);
    });
    el.append(card);
  });
}

// ---------- scoring playground ----------
let demoBuf = null, takeBuf = null;
const history = [];
function fillClipSelect() {
  const sel = $('#clipSel');
  if (!sel) return;
  const cur = sel.value;
  sel.replaceChildren();
  packs.forEach((p) => {
    const g = document.createElement('optgroup');
    g.label = `${p.icon} ${p.name}`;
    p.clips.forEach((c) => g.append(h(`<option value="${p.id}/${c.id}">${esc(c.name)} ${'★'.repeat(c.stars || 2)}</option>`)));
    sel.append(g);
  });
  if (cur) sel.value = cur;
}
function drawPlay(ref, rec) {
  const cv = $('#playWave'), dpr = Math.min(2, devicePixelRatio || 1);
  const w = (cv.width = cv.clientWidth * dpr), hh = (cv.height = cv.clientHeight * dpr);
  const g = cv.getContext('2d');
  g.fillStyle = '#0c0912'; g.fillRect(0, 0, w, hh);
  g.fillStyle = 'rgba(255,180,180,.3)'; g.fillRect(0, hh / 2 - dpr, w, 2 * dpr);
  const total = Math.max(ref?.duration || 0, rec?.duration || 0) || 1;
  const bars = (buf, color, scale) => {
    if (!buf) return;
    const d = buf.getChannelData(0), cols = Math.floor((w / (4 * dpr)) * (buf.duration / total));
    const step = d.length / cols;
    let mx = 0.05; const pk = [];
    for (let i = 0; i < cols; i++) { let m = 0; for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j += 2) m = Math.max(m, Math.abs(d[j])); pk.push(m); mx = Math.max(mx, m); }
    g.fillStyle = color;
    pk.forEach((v, i) => { const y = (v / mx) * hh * scale; g.fillRect(i * 4 * dpr, hh / 2 - y, 2.5 * dpr, y * 2); });
  };
  bars(rec, '#ff6fb0', 0.46);
  bars(ref, 'rgba(160,210,255,.9)', rec ? 0.28 : 0.42);
}
function showResult(res, va, label) {
  const pct = res.note === 'silent' ? 0 : res.pct;
  $('#res').replaceChildren(h(`<div>
    <div class="result-grid">
      <div class="stat big"><b>${pct}%</b><span>score</span></div>
      <div class="stat"><b>${Math.round((res.pitch || 0) * 100)}</b><span>pitch</span></div>
      <div class="stat"><b>${Math.round((res.rhythm || 0) * 100)}</b><span>rhythm</span></div>
      <div class="stat"><b>${Math.round((res.tone || 0) * 100)}</b><span>tone</span></div>
    </div>
    <div class="va">${va ? `Voice detected: <b>${va.speech ? 'YES' : 'NO → scored 0'}</b> · active ${va.activeSec.toFixed(2)}s · noise floor ${va.floor.toFixed(4)} · peak ${va.peak.toFixed(3)}` : ''}</div>
  </div>`));
  history.unshift({ label, clip: $('#clipSel').selectedOptions[0]?.textContent || '', pct, pitch: res.pitch, rhythm: res.rhythm, tone: res.tone, speech: va?.speech });
  $('#hist').replaceChildren(h(`<table><tr><th>take</th><th>clip</th><th>score</th><th>pitch</th><th>rhythm</th><th>tone</th><th>voice</th></tr>${history.slice(0, 12).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.clip)}</td><td><b>${x.pct}%</b></td><td>${Math.round((x.pitch || 0) * 100)}</td><td>${Math.round((x.rhythm || 0) * 100)}</td><td>${Math.round((x.tone || 0) * 100)}</td><td>${x.speech === false ? '🤐' : '✔'}</td></tr>`).join('')}</table>`));
}
async function loadDemo() {
  await A.resume();
  demoBuf = await A.getClip($('#clipSel').value, packs);
  return demoBuf;
}
async function recordLikeGame() {
  await A.resume();
  try { await A.initMic(); } catch { return toast('Mic blocked – allow microphone access'); }
  const demo = await loadDemo();
  const t0 = A.ctx.currentTime + 0.4;
  const recStart = t0 + demo.duration + GAP_AFTER_DEMO, recEnd = recStart + recDurFor(demo.duration);
  const status = $('#recStatus');
  A.playAt(demo, t0);
  status.textContent = '🔊 demo…';
  while (A.ctx.currentTime < recStart) { status.textContent = A.ctx.currentTime < t0 + demo.duration ? '🔊 demo…' : '⏳ get ready…'; await sleep(40); }
  status.textContent = '🔴 GO! mimic now';
  while (A.ctx.currentTime < recEnd + 0.3) await sleep(40);
  status.textContent = 'scoring…';
  const sr = A.ctx.sampleRate;
  const raw = A.captured(recStart - 0.1, recEnd + 0.2);
  const noise = A.captured(t0 + demo.duration + 0.25, recStart - 0.1);
  const va = voiceActivity(raw, sr, noise);
  takeBuf = A.toBuffer(raw, sr);
  const res = va.speech ? await scoreMimic(demo, A.toBuffer(va.trimmed, sr)) : { pct: 0, pitch: 0, rhythm: 0, tone: 0, note: 'silent' };
  drawPlay(demo, takeBuf);
  showResult(res, va, 'your mic');
  status.textContent = '';
}
async function simulate(skill) {
  const demo = await loadDemo();
  const recDur = recDurFor(demo.duration), sr = 44100;
  const samples = await makeTake(demo, skill, recDur);
  const va = voiceActivity(samples, sr, new Float32Array(sr * 0.5).map(() => (Math.random() * 2 - 1) * 0.003));
  takeBuf = A.toBuffer(samples, sr);
  const res = va.speech ? await scoreMimic(demo, A.toBuffer(va.trimmed, sr)) : { pct: 0, pitch: 0, rhythm: 0, tone: 0, note: 'silent' };
  drawPlay(demo, takeBuf);
  showResult(res, va, `bot: ${skill}`);
}

// ---------- page ----------
function renderLogin(msg = '') {
  $('#app').replaceChildren(h(`<form class="panel login">
    <h1 class="title-3d" style="font-size:56px">Test Lab</h1>
    <p class="muted">Enter the admin key (server console / <code>data/admin-key.txt</code>).</p>
    <input id="key" type="password" placeholder="Admin key" autocomplete="current-password" />
    <div style="color:#ff8a8a;min-height:20px">${esc(msg)}</div>
    <button class="btn green" style="width:100%">ENTER</button>
  </form>`));
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    key = $('#key').value.trim();
    const r = await fetch('/api/admin/check', { headers: { 'x-admin-key': key } });
    if (r.ok) { localStorage.setItem('mv_admin', key); renderLab(); } else renderLogin('Wrong key');
  };
}
function renderLab() {
  $('#app').replaceChildren(h(`<div>
    <div class="top"><h1 class="title-3d">Test Lab</h1><nav><a href="/" target="_blank">🎮 Game</a><a href="/admin" target="_blank">🎵 Sound packs</a></nav></div>
    <div class="grid">
      <div>
        <div class="panel">
          <h2>Quick test room</h2>
          <div class="row">
            <span class="muted">Bots</span><input type="number" id="botN" min="1" max="7" value="3" />
            <select id="botSkill">${Object.entries(SKILLS).map(([k, v]) => `<option value="${k}" ${k === 'random' ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <label class="row muted"><input type="checkbox" id="botThrow" checked /> bots throw at bad takes</label>
            <button class="btn small green" id="btnQuick">＋ CREATE ROOM WITH BOTS</button>
          </div>
          <p class="muted" style="margin:10px 0 0">A bot hosts the room. Open it as a player (button on the room card) to play against the bots, then hit FORCE START here. Use SKIP / rounds / next spin to jump to whatever you want to test.</p>
          <h3>Bots in this tab</h3>
          <div id="botList"></div>
        </div>
        <div class="panel" style="margin-top:20px">
          <h2>Live rooms</h2>
          <div id="rooms"></div>
        </div>
      </div>
      <div>
        <div class="panel play">
          <h2>Scoring playground</h2>
          <div class="row"><select id="clipSel" style="flex:1"></select><button class="btn small ghost" id="btnDemo">▶ DEMO</button></div>
          <div class="row" style="margin-top:10px">
            <button class="btn small pink" id="btnRec">🎤 RECORD (game timing)</button>
            <span id="recStatus" class="muted"></span>
          </div>
          <div class="row" style="margin-top:10px"><span class="muted">Simulate:</span>${['great', 'ok', 'bad', 'wrong', 'silent'].map((s) => `<button class="btn small ghost" data-sim="${s}">${s}</button>`).join('')}</div>
          <div class="wave-wrap" style="margin-top:12px"><canvas id="playWave"></canvas><div class="legend"><span class="l-ref">● DEMO</span><span class="l-rec">● TAKE</span></div></div>
          <div class="row" style="margin-top:8px"><button class="btn small ghost" id="btnTake">▶ PLAY TAKE</button></div>
          <div id="res"></div>
          <div id="hist"></div>
        </div>
        <div class="panel" style="margin-top:20px">
          <h2>Log</h2>
          <div class="log" id="log"></div>
        </div>
      </div>
    </div>
  </div>`));
  fillClipSelect();
  renderBots();
  $('#btnQuick').onclick = async () => {
    await A.resume();
    const n = Math.max(1, Math.min(7, +$('#botN').value || 3));
    const skill = $('#botSkill').value, throws = $('#botThrow').checked;
    const host = newBot(skill, throws);
    await host.create();
    for (let k = 0; k < 40 && !host.code; k++) await sleep(100);
    if (!host.code) return toast('Could not create a room');
    for (let i = 1; i < n; i++) newBot(skill, throws).join(host.code);
    renderBots();
    toast(`Room ${host.code} ready – open it as a player`);
  };
  $('#btnDemo').onclick = async () => A.playBuffer(await loadDemo());
  $('#btnRec').onclick = () => recordLikeGame().catch((e) => toast(e.message));
  $('#btnTake').onclick = async () => { if (takeBuf) { await A.resume(); A.playBuffer(takeBuf); } };
  document.querySelectorAll('[data-sim]').forEach((b) => { b.onclick = () => simulate(b.dataset.sim).catch((e) => toast(e.message)); });
  $('#clipSel').onchange = () => { takeBuf = null; loadDemo().then((d) => drawPlay(d, null)); };
  openCtl();
  pollRooms();
}

(async () => {
  packs = await (await fetch('/api/packs')).json();
  if (!key) return renderLogin();
  const r = await fetch('/api/admin/check', { headers: { 'x-admin-key': key } });
  if (r.ok) renderLab(); else renderLogin();
})();
