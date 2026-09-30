import * as A from './audio.js';
import { scoreMimic, voiceActivity } from './analyze.js';
import * as V from './voice.js';
import * as S from './scene.js';
import * as N from './net.js';
import { ROUNDS, MAX_PLAYERS, LOOK_OPTIONS, THROWABLES, GAP_AFTER_DEMO, ROUND_OPTIONS, recDurFor, randomLook } from './shared.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stars = (n) => '★'.repeat(n || 2) + '☆'.repeat(3 - (n || 2));

// ---------- identity ----------
const pid = sessionStorage.getItem('mv_pid') || (() => { const id = crypto.randomUUID(); sessionStorage.setItem('mv_pid', id); return id; })();
// The profile lives in localStorage and, as a backup, a year-long cookie: some browsers wipe one of them
// (storage pressure, privacy cleaners), and losing it means making your player again.
const PROFILE_COOKIE = 'mv_profile';
function readProfile() {
  let raw = null;
  try { raw = localStorage.getItem('mv_profile'); } catch {}
  if (!raw) raw = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith(PROFILE_COOKIE + '='))?.slice(PROFILE_COOKIE.length + 1) || '');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
let profile = readProfile();
navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data
const level = () => 1 + Math.floor((profile?.xp || 0) / 400);
function saveProfile() {
  const raw = JSON.stringify(profile);
  try { localStorage.setItem('mv_profile', raw); } catch {}
  document.cookie = `${PROFILE_COOKIE}=${encodeURIComponent(raw)}; max-age=${400 * 86400}; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
const helloMsg = () => ({ t: 'hello', pid, profile: { name: profile?.name || 'Player', look: profile?.look, level: level(), fid: profile?.fid } });

// ---------- state ----------
const G = { shownScores: {}, room: null, packs: [], clips: {}, subs: {}, recs: {}, segs: [], code: null, prevPhase: null, revealIdx: -1, screen: null };
const ui = { talkIdx: -1, talkSrc: null, draw: null, micTest: false };
const me = () => G.room?.players.find((p) => p.id === pid);
const idxOf = (id) => G.room ? G.room.players.findIndex((p) => p.id === id) : -1;
const nameOf = (id) => G.room?.players.find((p) => p.id === id)?.name || 'Someone';
const isHost = () => G.room && G.room.hostId === pid;
const packOf = (key) => G.packs.find((p) => p.id === key.split('/')[0]);
// pack artwork: the uploaded cover image if there is one, else the emoji on the pack colour
const packArt = (pk, cls, colorVar = false) => {
  const color = esc(pk?.color || '#c9772f');
  const bg = colorVar ? `--pc:${color}` : `background:${color}`;
  return pk?.image
    ? `<div class="${cls} has-img" style="${bg};background-image:url('${esc(pk.image)}')"></div>`
    : `<div class="${cls}" style="${bg}">${esc(pk?.icon || '🎵')}</div>`;
};
const clipMeta = (key) => { const p = packOf(key); return p && p.clips.find((c) => c.id === key.split('/')[1]); };
const ctxTimeFor = (serverMs) => A.ctx.currentTime + (serverMs - N.serverNow()) / 1000;

// ---------- avatars ----------
function shade(hex, amt) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
function drawAvatar(cv, lk, w = 112, hgt = 76) {
  const L = { shirt: '#2f6fe0', skin: '#f2c29a', hair: '#7a3f1d', style: 'cap', ...(lk || {}) };
  const dpr = 2;
  cv.width = w * dpr; cv.height = hgt * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const bg = g.createLinearGradient(0, 0, 0, hgt);
  bg.addColorStop(0, L.shirt); bg.addColorStop(1, shade(L.shirt, -30));
  g.fillStyle = bg; g.fillRect(0, 0, w, hgt);
  const r = hgt * 0.34, cx = w / 2, cy = hgt * 0.6;
  g.fillStyle = shade(L.shirt, -45);
  g.beginPath(); g.ellipse(cx, hgt + r * 0.3, r * 1.5, r * 0.9, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = L.skin;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  if (L.style !== 'bald') {
    g.fillStyle = L.hair;
    g.beginPath(); g.arc(cx, cy - r * 0.08, r * 1.04, Math.PI * 1.05, Math.PI * 1.95); g.fill();
    if (L.style === 'spiky') for (let i = 0; i < 5; i++) { const x = cx - r * 0.7 + i * r * 0.35; g.beginPath(); g.moveTo(x - r * 0.18, cy - r * 0.7); g.lineTo(x, cy - r * 1.3); g.lineTo(x + r * 0.18, cy - r * 0.7); g.fill(); }
    if (L.style === 'bun') { g.beginPath(); g.arc(cx, cy - r * 1.05, r * 0.35, 0, Math.PI * 2); g.fill(); }
  } else {
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.beginPath(); g.ellipse(cx - r * 0.35, cy - r * 0.55, r * 0.25, r * 0.12, -0.5, 0, Math.PI * 2); g.fill();
  }
  [-1, 1].forEach((s) => {
    g.fillStyle = '#fff'; g.beginPath(); g.ellipse(cx + s * r * 0.34, cy - r * 0.05, r * 0.22, r * 0.26, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1d1414'; g.beginPath(); g.arc(cx + s * r * 0.34, cy - r * 0.02, r * 0.11, 0, Math.PI * 2); g.fill();
  });
  g.strokeStyle = '#1d1414'; g.lineWidth = Math.max(1.5, r * 0.08); g.lineCap = 'round';
  g.beginPath(); g.arc(cx, cy + r * 0.28, r * 0.28, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  return cv;
}
const avatarEl = (look, w, hgt) => drawAvatar(document.createElement('canvas'), look, w, hgt);

// ---------- generic ui ----------
let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
async function banner(big, small = '') {
  A.sfx.whoosh();
  const b = $('#banner');
  b.replaceChildren(h(`<div class="bn">${esc(big)}${small ? `<small>${esc(small)}</small>` : ''}</div>`));
  await sleep(1650);
  b.replaceChildren();
}
function setStage(...els) { $('#stage').replaceChildren(...els.filter(Boolean)); }
function setSide(on) { $('#stage').classList.toggle('side', on); }
function openModal(el) { const m = $('#modal'); m.replaceChildren(el); m.hidden = false; }
function closeModal() { const m = $('#modal'); m.hidden = true; m.replaceChildren(); }
function showScreen(name) {
  G.screen = name;
  document.body.classList.toggle('at-home', name === 'homeScreen');
  document.body.classList.toggle('in-lobby', name === 'lobby');
  $('#lobbySlots').hidden = name !== 'lobby';
  if (name !== 'lobby') S.setLobby(false);
  $('#friendRail').hidden = name !== 'homeScreen' && name !== 'lobby';
  if (name !== 'homeScreen' && name !== 'lobby') { setRailOpen(false); $('#ctxMenu').hidden = true; }
  updateChatVisibility();
  ['profileScreen', 'homeScreen', 'lobby'].forEach((id) => { $('#' + id).hidden = id !== name; });
  $('#hud').hidden = name !== 'game';
  if (name === 'homeScreen' && !G.code) chatOpen(false);
  if (name === 'game') chatOpen(false);
  if (name !== 'game') { setStage(); closeModal(); setSide(false); $('#powerBar').hidden = true; $('#heldPower').hidden = true; }
}
function setPhase(p) {
  $('.rb-round').textContent = `ROUND ${G.room?.round || 1} / ${G.room?.rounds || ROUNDS}`;
  $('.rb-phase').textContent = p;
}
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code !== 'Space') return; // Enter is for the chat
  const btn = $('#modal:not([hidden]) [data-primary]') || $('#stage [data-primary]') || $('section:not([hidden]) [data-primary]');
  if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
});
document.addEventListener('pointerdown', () => A.resume());

// ---------- profile screen ----------
function renderProfile(draft = profile ? structuredClone(profile) : { name: '', look: randomLook(), xp: 0, games: 0, wins: 0 }) {
  const box = $('#profForm');
  box.replaceChildren();
  box.append(h(`<label class="field"><span>Name</span><input id="profName" maxlength="14" placeholder="Your name" value="${esc(draft.name)}" autocomplete="off" /></label>`));
  const opts = [['skin', 'Skin'], ['shirt', 'Shirt'], ['pants', 'Pants'], ['hair', 'Hair colour']];
  const preview = () => S.setPlayers([{ id: 'me', name: draft.name || 'You', look: draft.look }]);
  opts.forEach(([k, label]) => {
    const row = h(`<div class="opt-row"><span>${label}</span><div class="swatches"></div></div>`);
    LOOK_OPTIONS[k].forEach((c) => {
      const b = h(`<button class="sw${draft.look[k] === c ? ' on' : ''}" style="background:${c}" aria-label="${c}"></button>`);
      b.onclick = () => { draft.look[k] = c; A.sfx.pop(); row.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b)); preview(); };
      $('.swatches', row).append(b);
    });
    box.append(row);
  });
  const st = h(`<div class="opt-row"><span>Hair style</span><div class="swatches"></div></div>`);
  LOOK_OPTIONS.style.forEach((v) => {
    const b = h(`<button class="chip${draft.look.style === v ? ' on' : ''}">${v}</button>`);
    b.onclick = () => { draft.look.style = v; A.sfx.pop(); st.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); preview(); };
    $('.swatches', st).append(b);
  });
  box.append(st);
  const acts = h(`<div class="actions">${profile ? '<button class="btn ghost small" id="btnBackProfile">← BACK</button>' : ''}<button class="btn ghost small" id="btnRandom">🎲 RANDOM</button><button class="btn green big" id="btnSaveProfile" data-primary>SAVE</button></div>`);
  box.append(acts);
  $('#profileScreen .title-3d').textContent = profile ? 'Edit Player' : 'Your Player';
  if (profile) $('#btnBackProfile', box).onclick = () => { A.sfx.click(); if (G.code) showRoomLobby(); else showHome(); };
  $('#profName', box).oninput = (e) => { draft.name = e.target.value; preview(); };
  $('#btnRandom', box).onclick = () => { A.sfx.pop(); renderProfile({ ...draft, look: randomLook() }); };
  $('#btnSaveProfile', box).onclick = () => {
    draft.name = draft.name.trim().slice(0, 14);
    if (!draft.name) { toast('Pick a name first'); $('#profName').focus(); return; }
    profile = draft; ensureFid(); saveProfile();
    N.setHello(helloMsg());
    N.send({ t: 'profile', profile: helloMsg().profile });
    A.sfx.fanfare();
    if (G.code) showRoomLobby(); else showHome();
  };
  S.setView('profile');
  preview();
}
function showProfile() { showScreen('profileScreen'); renderProfile(); }

// ---------- home ----------
// Full 3D stage in the background with you + up to 4 friends on it, public rooms on the right,
// a slim friends rail at the far right, create/join bottom-left, chat bottom-left.
function homeStagePlayers() {
  const crew = friends
    .map((f) => ({ f, st: friendStatus.get(f.fid) }))
    .sort((a, b) => (b.st?.online ? 1 : 0) - (a.st?.online ? 1 : 0))
    .slice(0, 4)
    .map(({ f, st }) => ({ id: 'f:' + f.fid, name: st?.name || f.name || '', look: st?.look || f.look }));
  // keep the stage lively even without friends
  let seed = 7;
  const rnd = (a) => a[(seed = (seed * 9301 + 49297) % 233280) % a.length];
  while (crew.length < 4) crew.push({ id: 'npc' + crew.length, name: '', look: { skin: rnd(LOOK_OPTIONS.skin), shirt: rnd(LOOK_OPTIONS.shirt), pants: rnd(LOOK_OPTIONS.pants), hair: rnd(LOOK_OPTIONS.hair), style: rnd(LOOK_OPTIONS.style) } });
  const me = { id: pid, name: profile.name, look: profile.look };
  return [crew[0], crew[1], me, crew[2], crew[3]];
}
function showHome() {
  showScreen('homeScreen');
  S.setPlayers(homeStagePlayers());
  S.allHome();
  S.setView('overview');
  renderFriends();
  pollSocial();
  const q = new URLSearchParams(location.search).get('room');
  if (q && !$('#joinCode').value) $('#joinCode').value = q.toUpperCase();
}
async function ensureMic() {
  await A.resume();
  V.start(pid).then(renderMicBtn);
  try { await A.initMic(); return true; }
  catch (e) { console.warn(e); toast('🎤 Mic blocked – allow microphone access or you will score 0', 4000); return false; }
}
function setupHome() {
  $('#btnCreateRoom').onclick = async () => { await ensureMic(); N.send({ t: 'create' }); };
  $('#joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#joinCode').value.trim().toUpperCase();
    if (code.length < 4) return toast('Enter the room code');
    await ensureMic();
    N.send({ t: 'join', code });
  };
}

// ---------- friends + public rooms ----------
// No accounts: every profile gets a permanent 6-letter friend code. Friends are kept on this device.
const FID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function ensureFid() {
  if (profile && !/^[A-Z0-9]{6}$/.test(profile.fid || '')) {
    profile.fid = Array.from({ length: 6 }, () => FID_CHARS[Math.floor(Math.random() * FID_CHARS.length)]).join('');
    saveProfile();
  }
}
let friends = (() => { try { return JSON.parse(localStorage.getItem('mv_friends')) || []; } catch { return []; } })();
const saveFriends = () => localStorage.setItem('mv_friends', JSON.stringify(friends));
const friendStatus = new Map(); // fid -> presence
const friendName = (fid) => friendStatus.get(fid)?.name || friends.find((f) => f.fid === fid)?.name || fid;
let pendingInvite = null; // invite a friend from the home screen: make a room first, then invite
// Friends sidebar, laid out like a game launcher's social panel: a slim strip of avatars that
// widens in place into three tabs – Friends (search, parties, online, offline), Messages, Add friend.
const railIsOpen = () => $('#friendRail').classList.contains('open');
const FP = { tab: 'list', q: '', thread: null }; // thread: 'all' (party chat) or 'f:FID'
const threadVisible = (tab) => railIsOpen() && !$('#friendRail').hidden && FP.tab === 'msgs' && FP.thread === tab;
function openThread(tab) {
  CH.msgs[tab] ||= [];
  FP.tab = 'msgs'; FP.thread = tab;
  if (!railIsOpen()) setRailOpen(true); else renderFriends();
  $('#fpSendInput').focus();
}
let incoming = []; // friend requests waiting for an answer
let outgoing = (() => { try { return JSON.parse(localStorage.getItem('mv_outgoing')) || []; } catch { return []; } })(); // codes added while that player was offline
const saveOutgoing = () => localStorage.setItem('mv_outgoing', JSON.stringify(outgoing));
const PC_ICON = '<svg class="pc" viewBox="0 0 24 24"><path d="M3 4h18v12H3zm2 2v8h14V6zM8 18h8v2H8z"/></svg>';
const PARTY_ICON = '<svg viewBox="0 0 24 24"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 13c-3.3 0-7 1.6-7 4v2h14v-2c0-2.4-3.7-4-7-4zm7 0c-.5 0-1 0-1.5.1 1.5.9 2.5 2.2 2.5 3.9v2h5v-2c0-2.3-3.3-4-6-4z"/></svg>';
const USER_ICON = '<svg viewBox="0 0 24 24"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z"/></svg>';
function ago(ts) {
  const s = Math.max(0, (Date.now() - (ts || 0)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function friendLine(st) {
  if (!st?.online) return 'Offline';
  if (st.room && st.phase && st.phase !== 'lobby') return `Playing · Round ${st.round || 1} - ${st.rounds || '?'}`;
  if (st.room) return 'In lobby';
  return 'Online';
}
const dotCls = (st) => (!st?.online ? 'off' : st.room ? 'game' : 'on');
function fpAvatar(look, st, size = 40) {
  const w = h(`<span class="fp-av${st?.online ? '' : ' is-off'}"><span class="dot ${dotCls(st)}"></span></span>`);
  w.prepend(look ? avatarEl(look, size, size) : h(`<span class="fp-ghost">${USER_ICON}</span>`));
  return w;
}
function fpRow(f) {
  const st = friendStatus.get(f.fid);
  const r = h(`<button class="fp-row"><span class="fp-txt"><b>${esc(friendName(f.fid))}</b><small>${st?.online ? PC_ICON : ''}${friendLine(st)}</small></span></button>`);
  r.prepend(fpAvatar(st?.look || f.look, st));
  r.onclick = r.oncontextmenu = (e) => { e.preventDefault(); friendMenu(f.fid, e.clientX - 230, e.clientY); };
  return r;
}
const fpGroup = (label, n) => h(`<div class="fp-group">${label} <em>${n}</em></div>`);
const fpUnread = () => Object.entries(CH.unread).filter(([k]) => k.startsWith('f:') || (k === 'all' && G.code)).reduce((a, [, n]) => a + n, 0);
function renderFriends() {
  const online = friends.filter((f) => friendStatus.get(f.fid)?.online);
  const offline = friends.filter((f) => !friendStatus.get(f.fid)?.online);
  const unread = fpUnread();
  // slim strip
  $('#railMe').replaceChildren(avatarEl(profile?.look, 48, 48));
  $('#railMe').classList.toggle('alert', !!(unread || incoming.length));
  $('#railCount').textContent = friends.length;
  $('#railCount').title = `${friends.length} friends · ${online.length} online`;
  const mini = $('#railMini');
  mini.replaceChildren();
  [...online, ...offline].forEach((f) => {
    const st = friendStatus.get(f.fid);
    const b = h(`<button class="mini-f" title="${esc(friendName(f.fid))} – ${friendLine(st)}"></button>`);
    b.append(fpAvatar(st?.look || f.look, st, 44));
    b.onclick = () => setRailOpen(true);
    b.oncontextmenu = (e) => { e.preventDefault(); friendMenu(f.fid, e.clientX - 230, e.clientY); };
    mini.append(b);
  });
  // tab badges
  const badge = (tab, n) => { const i = $(`#fpTabs [data-tab="${tab}"] i`); i.textContent = n || ''; i.hidden = !n; };
  badge('msgs', unread); badge('add', incoming.length);
  if (!railIsOpen()) return;
  // panel
  const me = $('#fpMe');
  me.replaceChildren(h(`<span class="fp-txt"><b>${esc(profile?.name || '')}</b><small>Online</small></span>`), h(`<span class="fp-edit" title="Edit your player">✏️</span>`));
  me.prepend(fpAvatar(profile?.look, { online: true }, 44));
  $$('#fpTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === FP.tab));
  if (FP.thread === 'all' && !G.code) FP.thread = null; // left the party
  const view = FP.tab === 'msgs' && FP.thread ? 'thread' : FP.tab;
  $$('#friendRail .fp-view').forEach((v) => (v.hidden = v.dataset.view !== view));
  if (FP.tab === 'list') renderFpList(online, offline);
  else if (view === 'thread') renderFpThread();
  else if (FP.tab === 'msgs') renderFpMsgs();
  else renderFpAdd();
}
function renderFpList(online, offline) {
  const box = $('#fpList');
  box.replaceChildren();
  if (!friends.length) {
    const e = h(`<div class="fp-empty">No friends yet<br><button class="fp-link">Add your first friend</button></div>`);
    $('.fp-link', e).onclick = () => fpTab('add');
    return box.append(e);
  }
  const q = FP.q.trim().toLowerCase();
  const match = (f) => !q || friendName(f.fid).toLowerCase().includes(q);
  const inRoom = online.filter((f) => friendStatus.get(f.fid).room && match(f));
  const free = online.filter((f) => !friendStatus.get(f.fid).room && match(f));
  const off = offline.filter(match);
  if (inRoom.length) {
    box.append(h(`<div class="fp-game"><span class="fp-logo">🎤</span>MIMIC VOICE <em>${inRoom.length}</em></div>`));
    const parties = new Map();
    inRoom.forEach((f) => { const c = friendStatus.get(f.fid).room; if (!parties.has(c)) parties.set(c, []); parties.get(c).push(f); });
    parties.forEach((fs) => {
      const st0 = friendStatus.get(fs[0].fid);
      const size = Math.max(st0.size || 0, fs.length);
      const card = h(`<div class="fp-party"><div class="fp-ph">${PARTY_ICON}Party ${size}/${st0.max || MAX_PLAYERS}${st0.roomPublic ? '<span class="pub">PUBLIC</span>' : ''}</div></div>`);
      fs.forEach((f) => card.append(fpRow(f)));
      const others = size - fs.length;
      if (others > 0) card.append(h(`<div class="fp-more">+${others} Other${others > 1 ? 's' : ''}</div>`));
      box.append(card);
    });
  }
  if (free.length) { box.append(fpGroup('Online', free.length)); free.forEach((f) => box.append(fpRow(f))); }
  if (off.length) { box.append(fpGroup('Offline', off.length)); off.forEach((f) => box.append(fpRow(f))); }
  if (q && !inRoom.length && !free.length && !off.length) box.append(h(`<div class="fp-empty">No friend called "${esc(FP.q)}"</div>`));
}
function renderFpMsgs() {
  const box = $('#fpMsgs');
  box.replaceChildren();
  const convs = Object.keys(CH.msgs)
    .filter((k) => k.startsWith('f:') && CH.msgs[k].length)
    .map((k) => ({ fid: k.slice(2), last: CH.msgs[k][CH.msgs[k].length - 1], n: CH.unread[k] || 0 }))
    .sort((x, y) => (y.last.ts || 0) - (x.last.ts || 0));
  if (G.code) {
    const arr = (CH.msgs.all || []).filter((m) => !m.sys && !m.to);
    const last = arr[arr.length - 1], n = CH.unread.all || 0;
    const r = h(`<button class="fp-row fp-conv fp-party${n ? ' unread' : ''}"><span class="fp-av"><span class="fp-ghost">${PARTY_ICON}</span></span><span class="fp-txt"><b>Party chat</b><small>${last ? `${last.from === pid ? 'You' : esc(last.name)}: ${esc(last.text)}` : `Everyone in ${esc(G.code)}`}</small></span><span class="fp-time">${last?.ts ? ago(last.ts) : ''}${n ? `<i>${n}</i>` : ''}</span></button>`);
    r.onclick = () => openThread('all');
    box.append(r);
  }
  if (!convs.length && !G.code) return box.append(h(`<div class="fp-empty">No messages yet<br><small>Click a friend → Send message</small></div>`));
  convs.forEach(({ fid, last, n }) => {
    const st = friendStatus.get(fid);
    const mine = last.from === profile?.fid;
    const r = h(`<button class="fp-row fp-conv${n ? ' unread' : ''}"><span class="fp-txt"><b>${esc(friendName(fid))}</b><small>${mine ? 'You: ' : ''}${esc(last.text)}</small></span><span class="fp-time">${ago(last.ts)}${n ? `<i>${n}</i>` : ''}</span></button>`);
    r.prepend(fpAvatar(st?.look || friends.find((f) => f.fid === fid)?.look, st));
    r.onclick = () => openFriendChat(fid);
    r.oncontextmenu = (e) => { e.preventDefault(); friendMenu(fid, e.clientX - 230, e.clientY); };
    box.append(r);
  });
}
function renderFpThread() {
  const tab = FP.thread;
  CH.unread[tab] = 0;
  const who = $('#fpWho');
  if (tab === 'all') who.innerHTML = `<span class="fp-txt"><b>Party chat</b><small>${G.room?.players.length || 1} in party ${esc(G.code || '')}</small></span>`;
  else {
    const fid = tab.slice(2), st = friendStatus.get(fid);
    who.replaceChildren(h(`<span class="fp-txt"><b>${esc(friendName(fid))}</b><small>${friendLine(st)}</small></span>`));
    who.prepend(fpAvatar(st?.look || friends.find((f) => f.fid === fid)?.look, st, 36));
  }
  $('#fpSendInput').placeholder = tab === 'all' ? 'Message the party…' : `Message ${friendName(tab.slice(2))}…`;
  const list = $('#fpThread');
  list.replaceChildren();
  const arr = CH.msgs[tab] || [];
  if (!arr.length) list.append(h(`<div class="fp-empty"><small>${tab === 'all' ? 'Say hi to the party 👋' : 'No messages yet – say hi 👋'}</small></div>`));
  arr.forEach((m) => {
    if (m.sys) return list.append(h(`<div class="fp-sys">${m.html}</div>`));
    const mine = m.fdm ? m.from === profile?.fid : m.from === pid;
    list.append(h(`<div class="fp-msg${mine ? ' mine' : ''}${m.to && !m.fdm ? ' dm' : ''}">${mine ? '' : `<b>${esc(m.name)}${m.to && !m.fdm ? ' 🔒' : ''}</b>`}${esc(m.text)}</div>`));
  });
  list.scrollTop = list.scrollHeight;
}
function renderFpAdd() {
  $('#fpMyCode').innerHTML = `Your code <b>#${esc(profile?.fid || '')}</b><span>Copy</span>`;
  const box = $('#fpReqs');
  box.replaceChildren();
  if (incoming.length) {
    box.append(fpGroup('Incoming', incoming.length));
    incoming.forEach((f) => {
      const r = h(`<div class="fp-row fp-req"><span class="fp-txt"><b>${esc(f.name || f.fid)}</b><small>#${esc(f.fid)}</small></span><button class="fp-x yes" title="Accept">✓</button><button class="fp-x no" title="Decline">✕</button></div>`);
      r.prepend(fpAvatar(f.look, { online: true }));
      $('.yes', r).onclick = () => acceptFriend(f);
      $('.no', r).onclick = () => { incoming = incoming.filter((x) => x.fid !== f.fid); renderFriends(); };
      box.append(r);
    });
  }
  if (outgoing.length) {
    box.append(fpGroup('Outgoing', outgoing.length));
    outgoing.forEach((o) => {
      const r = h(`<div class="fp-row fp-req"><span class="fp-txt"><b>#${esc(o.fid)}</b><small>Sends when they come online</small></span><button class="fp-x no" title="Cancel">✕</button></div>`);
      r.prepend(fpAvatar(null, null));
      $('.no', r).onclick = () => { outgoing = outgoing.filter((x) => x.fid !== o.fid); saveOutgoing(); renderFriends(); };
      box.append(r);
    });
  }
  if (blocked.length) {
    box.append(fpGroup('Blocked', blocked.length));
    blocked.forEach((b) => {
      const r = h(`<div class="fp-row fp-req"><span class="fp-txt"><b>${esc(b.name)}</b><small>${b.fid ? '#' + esc(b.fid) : 'blocked'}</small></span><button class="fp-x no" title="Unblock">✕</button></div>`);
      r.prepend(fpAvatar(null, null));
      $('.no', r).onclick = () => setBlocked({ id: roomPlayer(b.key)?.id, fid: b.fid, name: b.name }, false);
      box.append(r);
    });
  }
  if (!incoming.length && !outgoing.length && !blocked.length) box.append(h(`<div class="fp-empty"><small>Share your code with friends,<br>or type theirs above.</small></div>`));
}
// ---- blocking: kept on this device, keyed by friend code (or player id for old clients)
let blocked = (() => { try { return JSON.parse(localStorage.getItem('mv_blocked')) || []; } catch { return []; } })();
const saveBlocked = () => localStorage.setItem('mv_blocked', JSON.stringify(blocked));
const blockKey = (p) => p?.fid || p?.id;
const isBlocked = (p) => !!p && blocked.some((b) => b.key === blockKey(p));
const isBlockedFid = (fid) => !!fid && blocked.some((b) => b.key === fid);
const roomPlayer = (id) => G.room?.players.find((p) => p.id === id);
// blocked players are silent in voice chat
function applyBlocks() { (G.room?.players || []).forEach((p) => { if (p.id !== pid && isBlocked(p)) V.setPeerVolume(p.id, 0); }); }
function setBlocked(p, on) {
  const key = blockKey(p);
  blocked = blocked.filter((b) => b.key !== key);
  if (on) {
    blocked.push({ key, fid: p.fid || null, name: p.name });
    friends = friends.filter((f) => f.fid !== p.fid); saveFriends();
    incoming = incoming.filter((f) => f.fid !== p.fid);
    V.setPeerVolume(p.id, 0);
    // their earlier messages disappear too
    for (const tab of Object.keys(CH.msgs)) CH.msgs[tab] = CH.msgs[tab].filter((m) => (m.fdm ? m.from !== p.fid : m.from !== p.id));
    if (p.fid) { delete CH.msgs['f:' + p.fid]; CH.openF.delete('f:' + p.fid); saveDms(); }
    renderChatTabs(); renderChatList();
    toast(`⛔ ${p.name} blocked – you won't hear or see their messages`);
  } else {
    if (p.id && roomPlayer(p.id)) V.setPeerVolume(p.id, peerMuted.has(p.id) ? 0 : 1);
    toast(`${p.name} unblocked`);
  }
  saveBlocked();
  renderFriends(); renderSeats();
}
function reportPlayer(p) {
  const reasons = ['Offensive voice or language', 'Spam', 'Cheating', 'Something else'];
  const box = h(`<div class="panel mbox"><h2>🚩 Report ${esc(p.name)}</h2><p>What's wrong?</p><div class="report-reasons">${reasons.map((r) => `<button class="btn small ghost" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div><div class="actions"><button class="btn ghost" id="repNo">CANCEL</button></div></div>`);
  box.onclick = (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    closeModal();
    N.send({ t: 'report', pid: p.id, reason: b.dataset.r });
  };
  $('#repNo', box).onclick = closeModal;
  openModal(box);
}
// right-click on a player in a party (their character, name tag or card): add friend / report / block
function playerMenu(p, x, y) {
  if (!p || p.id === pid || p.bot) return;
  const isFriend = p.fid && friends.some((f) => f.fid === p.fid);
  const menu = $('#ctxMenu');
  menu.innerHTML = `<div class="cm-title">${esc(p.name)}</div>
    ${isFriend ? '<button data-a="msg">💬 Send message</button>' : `<button data-a="add" ${p.fid && !isBlocked(p) ? '' : 'disabled'}>➕ Add friend</button>`}
    <button data-a="report">🚩 Report</button>
    ${isBlocked(p) ? '<button data-a="unblock">✅ Unblock</button>' : '<button data-a="block" class="danger">⛔ Block</button>'}`;
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 230))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - 190))}px`;
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b || b.disabled) return;
    menu.hidden = true;
    A.sfx.click();
    const a = b.dataset.a;
    if (a === 'add') { N.send({ t: 'friendAdd', fid: p.fid }); toast(`Friend request sent to ${p.name}`); }
    else if (a === 'msg') openFriendChat(p.fid);
    else if (a === 'report') reportPlayer(p);
    else setBlocked(p, a === 'block');
  };
}

function acceptFriend(f) {
  incoming = incoming.filter((x) => x.fid !== f.fid);
  if (!friends.some((x) => x.fid === f.fid)) friends.push({ fid: f.fid, name: f.name, look: f.look });
  saveFriends(); renderFriends(); pollSocial();
  toast(`${f.name} added as a friend 🎉`);
  if (G.screen === 'homeScreen') S.setPlayers(homeStagePlayers());
}
function fpTab(tab) {
  FP.tab = tab;
  FP.thread = null;
  A.sfx.click();
  renderFriends();
  if (tab === 'add') $('#friendCode').focus();
}
function setRailOpen(on) {
  $('#friendRail').classList.toggle('open', on);
  document.body.classList.toggle('rail-open', on);
  if (on) A.sfx.pop();
  $('#ctxMenu').hidden = true;
  renderFriends();
  if (G.screen === 'lobby') setTimeout(frameLobby, 280); // the party row re-fits once the panel has moved
}
// kept for older call sites
function openDrawer() { setRailOpen(true); }
function closeDrawer() { setRailOpen(false); }
// right-click menu on a friend
function friendMenu(fid, x, y) {
  const st = friendStatus.get(fid);
  const menu = $('#ctxMenu');
  const inParty = st?.online && st.room && st.phase === 'lobby';
  menu.innerHTML = `<div class="cm-title">${esc(friendName(fid))}</div>
    <button data-a="invite" ${st?.online ? '' : 'disabled'}>📨 Invite to my party</button>
    <button data-a="join" ${inParty ? '' : 'disabled'}>🚪 Ask to join their party</button>
    <button data-a="msg">💬 Send message</button>
    <button data-a="remove" class="danger">✕ Remove friend</button>`;
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 230))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - 220))}px`;
  menu.onclick = async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b || b.disabled) return;
    menu.hidden = true;
    A.sfx.click();
    if (b.dataset.a === 'invite') {
      if (G.code) N.send({ t: 'invite', fid });
      else { pendingInvite = fid; await ensureMic(); N.send({ t: 'create' }); toast('Opening a party for you two…'); }
    } else if (b.dataset.a === 'join') {
      N.send({ t: 'joinReq', fid });
    } else if (b.dataset.a === 'msg') {
      openFriendChat(fid);
    } else if (b.dataset.a === 'remove') {
      friends = friends.filter((f) => f.fid !== fid); saveFriends(); renderFriends();
    }
  };
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').hidden = true; });
function renderRoomList(list) {
  const box = $('#roomList');
  if (!box) return;
  box.replaceChildren();
  if (!list.length) { box.append(h(`<div class="empty-note">No public rooms yet.<br>Hit ⚡ QUICK to open one!</div>`)); return; }
  list.forEach((r) => {
    const open = r.phase === 'lobby' && r.players < r.max;
    const card = h(`<button class="room-card"${open ? '' : ' disabled'}>
      <div class="rc-top"><b>${esc(r.host)}'s room</b><span class="rc-code">${esc(r.code)}</span></div>
      <div class="rc-bottom"><span>👥 ${r.players}/${r.max}</span><span>🔁 ${r.rounds} rounds</span><span class="rc-state ${open ? 'open' : ''}">${open ? 'JOIN ➜' : `playing · ${r.round}/${r.rounds}`}</span></div>
    </button>`);
    if (open) card.onclick = async () => { await ensureMic(); N.send({ t: 'join', code: r.code }); };
    box.append(card);
  });
}
function pollSocial() {
  if (G.screen === 'homeScreen') N.send({ t: 'listRooms' });
  const fids = [...friends.map((f) => f.fid), ...outgoing.map((o) => o.fid)];
  if ((G.screen === 'homeScreen' || G.screen === 'lobby') && fids.length) N.send({ t: 'friendsStatus', fids });
}
function setupSocial() {
  const codeOk = () => /^[A-Z0-9]{6}$/.test($('#friendCode').value.trim().toUpperCase());
  $('#friendCode').oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); $('#fpAddBtn').disabled = !codeOk(); };
  $('#friendForm').onsubmit = (e) => {
    e.preventDefault();
    const code = $('#friendCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return toast('Friend codes are 6 letters/numbers');
    if (code === profile?.fid) return toast("That's your own code 😄");
    if (friends.some((f) => f.fid === code)) return toast('Already in your friends');
    N.send({ t: 'friendAdd', fid: code });
    $('#friendCode').value = '';
    $('#fpAddBtn').disabled = true;
  };
  $('#fpBack').onclick = () => { FP.thread = null; A.sfx.click(); renderFriends(); };
  $('#fpSend').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#fpSendInput');
    const text = inp.value.trim();
    inp.value = '';
    if (!text || !FP.thread) return;
    if (FP.thread === 'all') N.send({ t: 'chat', text });
    else N.send({ t: 'fdm', fid: FP.thread.slice(2), text });
  };
  $('#fpSendInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
  $('#fpTabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) fpTab(b.dataset.tab); };
  $('#fpSearch').oninput = (e) => { FP.q = e.target.value; renderFriends(); };
  $('#fpMe').onclick = (e) => { if (e.target.closest('.fp-edit')) { setRailOpen(false); showProfile(); } };
  $('#fpMyCode').onclick = async () => { try { await navigator.clipboard.writeText(profile.fid); toast('Friend code copied'); } catch { toast(profile.fid); } };
  $('#railMe').onclick = () => setRailOpen(!railIsOpen());
  $('#railCount').onclick = () => setRailOpen(true);
  $('#railAdd').onclick = () => { setRailOpen(true); fpTab('add'); };
  $('#railToggle').onclick = () => setRailOpen(false);
  $('#btnQuick').onclick = async () => { await ensureMic(); A.sfx.click(); N.send({ t: 'quickplay' }); };
  $('#visSeg').onclick = (e) => { const b = e.target.closest('button'); if (b && isHost()) { A.sfx.click(); N.send({ t: 'visibility', public: b.dataset.v === '1' }); } };
  setInterval(pollSocial, 4000);
}
function onFriendInfo(m) {
  if (!m.found) {
    if (!outgoing.some((o) => o.fid === m.fid)) { outgoing.push({ fid: m.fid, ts: Date.now() }); saveOutgoing(); }
    renderFriends();
    return toast(`#${m.fid} is offline – the request goes through when they come online`, 3500);
  }
  outgoing = outgoing.filter((o) => o.fid !== m.fid); saveOutgoing();
  if (friends.some((f) => f.fid === m.fid)) return;
  friends.push({ fid: m.fid, name: m.name, look: m.look });
  saveFriends();
  friendStatus.set(m.fid, m);
  toast(`${m.name} added as a friend 🎉`);
  renderFriends();
  if (G.screen === 'homeScreen') S.setPlayers(homeStagePlayers());
}
function onFriendRequest(m) {
  const f = m.from;
  if (!f?.fid || friends.some((x) => x.fid === f.fid) || isBlockedFid(f.fid)) return;
  if (!incoming.some((x) => x.fid === f.fid)) incoming.push(f);
  A.sfx.ding(1);
  toast(`👋 ${f.name} sent you a friend request – see Friends → Add`, 3500);
  renderFriends();
}
function onInvite(m) {
  if (isBlockedFid(m.from?.fid)) return;
  if (G.screen === 'game') return toast(`📨 ${m.from?.name} invited you to room ${m.code}`, 4000);
  const box = h(`<div class="panel mbox"><h2>📨 Invite</h2><p><b>${esc(m.from?.name || 'A friend')}</b> invited you to their party (room <b>${esc(m.code)}</b>)</p><div class="actions"><button class="btn ghost" id="invNo">NO THANKS</button><button class="btn green" id="invYes" data-primary>JOIN</button></div></div>`);
  $('#invNo', box).onclick = closeModal;
  $('#invYes', box).onclick = async () => { closeModal(); await ensureMic(); N.send({ t: 'join', code: m.code }); };
  A.sfx.ding(1);
  openModal(box);
}
// a friend wants into my party
function onJoinReq(m) {
  const f = m.from;
  if (isBlockedFid(f?.fid)) return N.send({ t: 'joinReqAnswer', fid: f.fid, ok: false });
  const box = h(`<div class="panel mbox"><h2>🚪 ${esc(f?.name || 'A friend')}</h2><p>wants to join your party</p><div class="actions"><button class="btn ghost" id="jrNo">DECLINE</button><button class="btn green" id="jrYes" data-primary>ACCEPT</button></div></div>`);
  $('#jrNo', box).onclick = () => { closeModal(); N.send({ t: 'joinReqAnswer', fid: f.fid, ok: false }); };
  $('#jrYes', box).onclick = () => { closeModal(); N.send({ t: 'joinReqAnswer', fid: f.fid, ok: true }); };
  A.sfx.ding(1);
  if (G.screen === 'game') { toast(`🚪 ${f?.name} wants to join – they can after this game`); N.send({ t: 'joinReqAnswer', fid: f.fid, ok: false }); return; }
  openModal(box);
}
async function onJoinReqResult(m) {
  if (!m.ok) return toast(`${m.name || 'Your friend'} couldn't let you in right now`);
  toast(`${m.name} accepted – joining…`);
  await ensureMic();
  N.send({ t: 'join', code: m.code });
}

// ---------- room lobby ----------
function showRoomLobby() {
  showScreen('lobby');
  S.setView('lobby');
  renderLobby();
}
// Party row on the 3D stage: characters appear as players join, you in the middle and everyone
// else filling outwards. Above each: name + ready; below: my mic toggle / a speaker to mute others.
// seats fill from the middle out
function lobbySeats(room) {
  const n = Math.max(1, room.players.length);
  const c = Math.floor((n - 1) / 2), order = [c];
  for (let d = 1; order.length < n; d++) { if (c + d < n) order.push(c + d); if (c - d >= 0 && order.length < n) order.push(c - d); }
  const mine = room.players.findIndex((p) => p.id === pid);
  let k = mine >= 0 ? 1 : 0;
  return { n, seats: room.players.map((p, i) => (i === mine ? order[0] : order[Math.min(k++, n - 1)])) };
}
const MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>';
const MIC_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/><path d="M4 3l17 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>';
const SPK_SVG = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
const SPK_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6m0-6l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';
const peerMuted = new Map(); // pid -> volume before I muted them
function micIcon(p) {
  if (p.bot) return { cls: 'bot', svg: '🤖', title: 'Bot' };
  if (p.id === pid) {
    const on = V.hasMic() && V.isOn();
    return { cls: on ? 'on' : 'off', svg: on ? MIC_SVG : MIC_OFF_SVG, title: on ? 'Voice chat on – click to mute yourself' : 'Voice chat off – click to talk' };
  }
  if (isBlocked(p)) return { cls: 'muted', svg: SPK_OFF_SVG, title: `You blocked ${p.name} – right-click them to unblock` };
  if (peerMuted.has(p.id)) return { cls: 'muted', svg: SPK_OFF_SVG, title: `You muted ${p.name} – click to hear them` };
  return { cls: p.micOn ? 'on' : 'quiet', svg: SPK_SVG, title: `Click to mute ${p.name} for you${p.micOn ? '' : ' (their mic is off)'}` };
}
function renderSeats() {
  const room = G.room;
  const box = $('#lobbySlots');
  if (!room || G.screen !== 'lobby') return;
  const { n, seats } = lobbySeats(room);
  const bySeat = new Map(room.players.map((p, i) => [seats[i], p]));
  S.setLobby(true);
  box.replaceChildren();
  for (let s = 0; s < n; s++) {
    const p = bySeat.get(s);
    if (!p) continue;
    const mic = micIcon(p);
    const el = h(`<div class="lslot${p.id === pid ? ' me' : ''}${p.ready ? ' ready' : ''}${p.connected === false ? ' gone' : ''}" data-seat="${s}" data-id="${p.id}">
      <div class="ls-tag"><b class="ls-name">${p.id === room.hostId ? '👑 ' : ''}${esc(p.name)}</b><span class="ls-ready">${p.ready ? '✓ READY' : 'NOT READY'}</span></div>
      <button class="ls-mic ${mic.cls}" title="${esc(mic.title)}">${mic.svg}</button>
    </div>`);
    el.oncontextmenu = (e) => { e.preventDefault(); playerMenu(p, e.clientX, e.clientY); };
    const mb = $('.ls-mic', el);
    if (p.bot) mb.disabled = true;
    else mb.onclick = () => (p.id === pid ? toggleVoice() : togglePeerMute(p.id));
    if (isHost() && p.id !== pid) {
      const kick = h(`<button class="ls-kick" title="Remove ${esc(p.name)} from the party">✕</button>`);
      kick.onclick = () => { A.sfx.click(); N.send({ t: 'kick', pid: p.id }); };
      $('.ls-tag', el).append(kick);
    }
    box.append(el);
  }
  layoutSeats();
}
// keep tags and buttons glued to the characters (the camera eases in and follows the mouse a little)
function layoutSeats() {
  if (G.screen !== 'lobby') return;
  $('#lobbySlots').querySelectorAll('.lslot').forEach((el) => {
    const r = S.seatScreen(+el.dataset.seat);
    el.style.left = `${r.x - r.w / 2}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.feet - r.top}px`;
  });
}
// the party row fills the space between the two lobby panels
function frameLobby() {
  if (G.screen !== 'lobby') return;
  const W = innerWidth, H = innerHeight;
  const l = $('#lobby .packs').getBoundingClientRect().right + 20;
  const r = $('#lobby .settings').getBoundingClientRect().left - 20;
  const top = $('#lobby .title-3d').getBoundingClientRect().bottom + 70; // room for the name tags
  const feet = $('#lobbyStatus').getBoundingClientRect().top - 72; // room for the mic/speaker buttons
  S.setLobbyFrame(l / W, r / W, top / H, feet / H);
}
window.addEventListener('resize', frameLobby);
function togglePeerMute(id) {
  const p = roomPlayer(id);
  if (isBlocked(p)) return toast(`You blocked ${p.name} – right-click them to unblock`);
  A.sfx.click();
  if (peerMuted.has(id)) { V.setPeerVolume(id, peerMuted.get(id) || 1); peerMuted.delete(id); }
  else { peerMuted.set(id, V.getPeerVolume(id)); V.setPeerVolume(id, 0); }
  renderSeats();
}
function renderLobby() {
  const room = G.room;
  if (!room || G.screen !== 'lobby') return;
  renderSeats();
  requestAnimationFrame(frameLobby); // measure once the panels have laid out
  $('#lobbyStatus').textContent = `${room.players.length}/${MAX_PLAYERS} players – ${room.players.every((p) => p.ready) ? 'ready when you are' : 'waiting for everyone to be ready'}`;
  $('#roomCode').textContent = room.code;
  document.querySelectorAll('#roundSeg button').forEach((b) => { b.classList.toggle('on', +b.dataset.v === room.rounds); b.disabled = !isHost(); });
  document.querySelectorAll('#visSeg button').forEach((b) => { b.classList.toggle('on', (b.dataset.v === '1') === !!room.public); b.disabled = !isHost(); });
  const btn = $('#btnStart');
  if (isHost()) {
    btn.textContent = 'START GAME';
    btn.disabled = !room.players.every((p) => p.ready);
    btn.className = 'btn big green';
  } else {
    const r = me()?.ready;
    btn.textContent = r ? 'NOT READY' : "I'M READY";
    btn.disabled = false;
    btn.className = r ? 'btn big ghost' : 'btn big green';
  }
  const packs = $('#packList');
  packs.replaceChildren();
  if (!G.packs.length) packs.append(h(`<div class="empty-note">No sound packs yet.<br>Upload some on the /admin page.</div>`));
  G.packs.forEach((pk) => {
    const on = room.packs.includes(pk.id);
    const row = h(`<div class="pack-row">
      ${packArt(pk, 'ic')}
      <div class="nm">${esc(pk.name)}<small>${pk.clips.length} sound${pk.clips.length === 1 ? '' : 's'}</small></div>
      <button class="eye" title="Preview a sound">👁</button>
      <input type="checkbox" class="chk" ${on ? 'checked' : ''} ${isHost() ? '' : 'disabled'} />
    </div>`);
    $('.eye', row).onclick = async () => {
      await A.resume();
      const c = pk.clips[Math.floor(Math.random() * pk.clips.length)];
      if (!c) return;
      toast(`🔊 ${c.name}`);
      A.playBuffer(await A.getClip(`${pk.id}/${c.id}`, G.packs));
    };
    $('.chk', row).onchange = (e) => {
      const set = new Set(room.packs);
      e.target.checked ? set.add(pk.id) : set.delete(pk.id);
      A.sfx.click();
      N.send({ t: 'packs', packs: [...set] });
    };
    packs.append(row);
  });
  $('#packCount').textContent = `${room.packs.filter((id) => G.packs.some((p) => p.id === id)).length} / ${G.packs.length} pack(s) selected${isHost() ? '' : ' · host picks'}`;
}
function setupLobby() {
  $('#btnStart').onclick = () => {
    A.sfx.click();
    if (isHost()) N.send({ t: 'start' });
    else N.send({ t: 'ready', v: !me()?.ready });
  };
  $('#btnLeave').onclick = () => { stopMatch(); N.send({ t: 'leave' }); V.leaveAll(); G.code = null; history.replaceState(null, '', location.pathname); showHome(); };
  $('#btnCopy').onclick = async () => {
    const link = `${location.origin}${location.pathname}?room=${G.room.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); } catch { toast(link, 5000); }
  };
  $('#roundSeg').onclick = (e) => { const b = e.target.closest('button'); if (b && isHost()) { A.sfx.click(); N.send({ t: 'settings', rounds: +b.dataset.v }); } };
  $('#btnMic').onclick = async () => { if (await ensureMic()) { ui.micTest = true; toast('Mic works! Make some noise 🎤'); } };
}

// ---------- HUD cards ----------
// fanned, overlapping cards: portrait header in the player's colour, big orange score
const KIND_COLOR = { add: '#f08a0c', mult: '#e0287a', swap: '#0fa874', sabotage: '#d81b46' };
function renderCards(activeId = null) {
  const wrap = $('#cards');
  wrap.replaceChildren();
  if (!G.room) return;
  G.room.players.forEach((p, i) => {
    const card = h(`<div class="pcard${p.id === activeId ? ' active' : ''}${p.connected ? '' : ' gone'}" data-id="${p.id}" style="--r:${[-5, -2, 2, 5, -4, 3, -3, 4][i % 8]}deg;z-index:${p.id === activeId ? 20 : i}"></div>`);
    if (!p.micOn && !p.bot) card.append(h(`<div class="muted" title="mic off">🔇</div>`));
    card.append(avatarEl(p.look, 112, 76));
    card.append(h(`<div class="pn">${esc(p.name)}</div>`));
    card.append(h(`<div class="sc">${p.score}</div>`));
    // points of a playback pop straight onto the card
    const before = G.shownScores[p.id] ?? p.score;
    if (p.score > before) { card.classList.add('bump'); card.append(h(`<div class="gain">+${p.score - before}</div>`)); A.sfx.ding(1); }
    G.shownScores[p.id] = p.score;
    let fx = null;
    if (p.active && (p.active.kind === 'add' || p.active.kind === 'mult')) fx = h(`<div class="fx" style="background:${KIND_COLOR[p.active.kind]}">${esc(p.active.label)}</div>`);
    else if (p.pending) fx = h(`<div class="fx" style="background:${KIND_COLOR[p.pending.kind] || '#e0287a'}">🎁 ${esc(p.pending.label)}</div>`);
    if (fx) card.append(fx);
    card.oncontextmenu = (e) => { e.preventDefault(); playerMenu(p, e.clientX, e.clientY); };
    if (G.room.phase === 'listen' && p.submitted) card.append(h(`<div class="done">✔</div>`));
    wrap.append(card);
  });
}
const SAB_INFO = {
  disturb: { icon: '⚡', name: 'MIC DISTURB', pick: 'Pick someone to sabotage! Their mic gets static + cut-outs.' },
  crap: { icon: '💩', name: 'CRAP MIC', pick: 'Pick someone to sabotage! They record through a cheap, broken mic.' },
};
const sabInfo = (t) => SAB_INFO[t] || SAB_INFO.disturb;
function cardsVisible(on) { $('#cards').classList.toggle('hide', !on); }
const POWER_SLOTS = [
  { key: 'disturb', cls: 'pw-sab', title: 'Mic disturb – static + cut-outs on a rival’s take' },
  { key: 'crap', cls: 'pw-crap', title: 'Crap mic – a rival records through a broken mic' },
  { key: 'swap', cls: 'pw-swap', title: 'Swap – trade takes with a player, scores included' },
];
const slotOf = (p) => (p.kind === 'swap' ? 'swap' : p.kind === 'sabotage' ? p.sab || 'disturb' : 'bonus');
const powerIcon = (cls) => cls === 'pw-bonus' ? '<span class="pw pw-bonus"><i class="star">⭐</i></span>'
  : `<span class="pw ${cls}"><span class="pw-mic">🎤</span>${cls === 'pw-sab' ? '<i>⚡</i>' : cls === 'pw-crap' ? '<i class="poo">💩</i>' : '<i class="rot">🔄</i>'}</span>`;
function renderPowers(showBar) {
  const my = me();
  const held = my?.pending || my?.active || my?.held || null;
  const slot = held ? slotOf(held) : null;
  const heldEl = $('#heldPower');
  heldEl.innerHTML = slot ? powerIcon(POWER_SLOTS.find((x) => x.key === slot)?.cls || 'pw-bonus') + `<b>${esc(held.title || held.label)}</b>` : '';
  heldEl.hidden = !slot || G.screen !== 'game';
  const bar = $('#powerBar');
  bar.hidden = !showBar;
  if (!showBar) return;
  bar.innerHTML = POWER_SLOTS.map((p) => `<div class="pw-slot${p.key === slot ? ' on' : ''}" title="${esc(p.title)}">${powerIcon(p.cls)}</div>`).join('');
}

// ---------- waveform panel ----------
function makeWave(total) {
  const wrap = h(`<div class="wave-wrap"><canvas></canvas><div class="legend"><span class="l-ref">● DEMO</span><span class="l-rec">● VOICE</span></div></div>`);
  return { wrap, cv: $('canvas', wrap), total, ref: null, refDur: 0, rec: null, recDur: 0, head: -1, cache: new Map(), live: null };
}
function peaksOf(W, key, samples, n) {
  const k = `${key}:${n}:${samples.length}`;
  if (W.cache.has(k)) return W.cache.get(k);
  const out = new Float32Array(n);
  const step = samples.length / n;
  let mx = 0.05;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor(i * step), b = Math.min(samples.length, Math.floor((i + 1) * step));
    for (let j = a; j < b; j += 2) { const v = Math.abs(samples[j]); if (v > m) m = v; }
    out[i] = m; if (m > mx) mx = m;
  }
  for (let i = 0; i < n; i++) out[i] /= mx;
  W.cache.set(k, out);
  return out;
}
// Like the reference: the demo sits in the middle band, dark margins either side.
// The playhead only runs across the demo; your take paints over it (pink) as you record.
function drawWave(W) {
  const cv = W.cv, dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(cv.clientWidth * dpr), hh = Math.round(cv.clientHeight * dpr);
  if (!w || !hh) return;
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; W.cache.clear(); if (W.live) W.live.pk = null; }
  const g = cv.getContext('2d');
  const x0 = w * 0.17, x1 = w * 0.83, span = x1 - x0, mid = hh / 2;
  g.fillStyle = '#07060b'; g.fillRect(0, 0, w, hh);
  g.fillStyle = '#1b1827'; g.fillRect(x0, 0, span, hh);
  g.fillStyle = 'rgba(255,180,180,.35)'; g.fillRect(0, mid - dpr, w, 2 * dpr);
  const colW = 3 * dpr, cols = Math.max(1, Math.floor(span / colW));
  const bars = (pk, from, to, outer, inner, scale) => {
    for (let i = from; i < to; i++) {
      const v = Math.max(0.02, pk[i] || 0) * hh * scale, x = x0 + i * colW;
      g.fillStyle = outer; g.fillRect(x, mid - v, colW * 0.95, v * 2);
      g.fillStyle = inner; g.fillRect(x + colW * 0.2, mid - v * 0.55, colW * 0.55, v * 1.1);
    }
  };
  // how far the take has been painted, in columns
  let recN = 0, recPk = null;
  if (W.rec) {
    const full = Math.max(1, Math.floor((cols * W.recDur) / W.total));
    recPk = peaksOf(W, 'rec', W.rec, full);
    recN = Math.min(cols, full);
  }
  if (W.live) {
    const L = W.live, sr = A.ctx.sampleRate;
    if (!L.pk) { L.pk = new Float32Array(cols); L.max = 0.05; L.t = L.start; }
    const until = Math.min(A.capturedUntil(), L.start + W.total);
    if (until > L.t) {
      const seg = A.captured(L.t, until);
      const perCol = (W.total * sr) / cols;
      const base = Math.round((L.t - L.start) * sr);
      for (let j = 0; j < seg.length; j++) {
        const col = Math.floor((base + j) / perCol);
        if (col >= cols) break;
        const v = Math.abs(seg[j]);
        if (v > L.pk[col]) L.pk[col] = v;
        if (v > L.max) L.max = v;
      }
      L.t = until;
    }
    recN = Math.min(cols, Math.ceil(((L.t - L.start) / W.total) * cols));
    recPk = L.pk.map((v) => v / L.max);
  }
  if (W.ref) {
    const n = Math.min(cols, Math.max(1, Math.floor((cols * W.refDur) / W.total)));
    bars(peaksOf(W, 'ref', W.ref, n), recN, n, '#4f8dff', '#e6f3ff', 0.42);
  }
  if (recPk) bars(recPk, 0, recN, '#ff4fa0', '#ffe3f1', 0.46);
  if (W.head >= 0 && W.head <= 1.001) {
    const x = x0 + Math.min(1, W.head) * span;
    g.fillStyle = '#ff2436'; g.shadowColor = '#ff2436'; g.shadowBlur = 12 * dpr;
    g.fillRect(x - 3 * dpr, 0, 6 * dpr, hh); g.shadowBlur = 0;
  }
}

// ---------- text chat ----------
// "All" tab + one private tab per other player. Private = the two players only (server-enforced).
const CH = { tab: 'all', msgs: { all: [], ...(() => { try { return JSON.parse(localStorage.getItem('mv_dms')) || {}; } catch { return {}; } })() }, unread: { all: 0 }, openF: new Set() };
function saveDms() {
  const dms = Object.fromEntries(Object.entries(CH.msgs).filter(([k]) => k.startsWith('f:')).map(([k, v]) => [k, v.slice(-50)]));
  try { localStorage.setItem('mv_dms', JSON.stringify(dms)); } catch {}
}
const chatIsOpen = () => !$('#chat').classList.contains('closed');
const tabOf = (m) => (m.fdm ? 'f:' + (m.from === profile?.fid ? m.to : m.from) : m.to ? (m.from === pid ? m.to : m.from) : 'all');
// outside a match, conversations live in the friends sidebar; the chat dock is for in-game only
function updateChatVisibility() { $('#chat').hidden = !(G.code && G.screen === 'game'); }
function openFriendChat(fid) {
  const tab = 'f:' + fid;
  CH.msgs[tab] ||= [];
  if (!$('#friendRail').hidden) return openThread(tab);
  CH.openF.add(tab);
  switchChatTab(tab);
}
const chatOthers = () => (G.code && G.room ? G.room.players.filter((p) => p.id !== pid) : []); // only while in a room
function renderChatBadge() {
  const n = Object.values(CH.unread).reduce((a, b) => a + b, 0);
  const b = $('#chatBadge'); b.hidden = !n; b.textContent = n;
}
function renderChatTabs() {
  const bar = $('#chatTabs');
  bar.replaceChildren();
  const others = chatOthers();
  const fTabs = [...CH.openF];
  const valid = (id) => (id === 'all' ? !!G.code : id.startsWith('f:') ? CH.openF.has(id) : others.some((p) => p.id === id));
  if (!valid(CH.tab)) CH.tab = G.code ? 'all' : fTabs[0] || 'all';
  const tabs = [...(G.code ? [{ id: 'all', label: '🌐 All' }] : []), ...others.map((p) => ({ id: p.id, label: `🔒 ${esc(p.name)}` })), ...fTabs.map((k) => ({ id: k, label: `👥 ${esc(friendName(k.slice(2)))}` }))];
  if (!tabs.length) tabs.push({ id: 'all', label: '💬 Chat' });
  tabs.forEach((t) => {
    const b = h(`<button type="button" class="ct${t.id === CH.tab ? ' on' : ''}">${t.label}${CH.unread[t.id] ? `<i>${CH.unread[t.id]}</i>` : ''}</button>`);
    b.onclick = () => switchChatTab(t.id);
    bar.append(b);
  });
  const name = CH.tab.startsWith('f:') ? friendName(CH.tab.slice(2)) : others.find((p) => p.id === CH.tab)?.name;
  $('#chatInput').placeholder = CH.tab === 'all' ? (G.code ? 'Message everyone… (@name = private)' : 'Right-click a friend → Send message') : `Message ${name}…`;
  $('#chatInput').disabled = CH.tab === 'all' && !G.code;
  $('#chat').classList.toggle('dm', CH.tab !== 'all');
}
function msgEl(m) {
  if (m.sys) return h(`<div class="cm sys">${m.html}</div>`);
  const p = m.fdm ? { look: friends.find((f) => f.fid === m.from)?.look } : G.room?.players.find((x) => x.id === m.from);
  const el = h(`<div class="cm${(m.fdm ? m.from === profile?.fid : m.from === pid) ? ' mine' : ''}${m.to ? ' dm' : ''}"><b class="who" style="color:${shade(p?.look?.shirt || '#ffcf3a', 70)}" title="Private chat">${esc(m.name)}</b>${esc(m.text)}</div>`);
  if (!m.fdm && m.from !== pid) $('.who', el).onclick = () => switchChatTab(m.from);
  return el;
}
function renderChatList() {
  const list = $('#chatList');
  list.replaceChildren();
  const arr = CH.msgs[CH.tab] || [];
  if (!arr.length) {
    const name = chatOthers().find((p) => p.id === CH.tab)?.name;
    list.append(h(`<div class="empty">${CH.tab === 'all' ? (G.code ? 'No messages yet – say hi 👋' : 'Chat with friends: right-click a friend → Send message') : `Private chat with ${esc(CH.tab.startsWith('f:') ? friendName(CH.tab.slice(2)) : name)}<br>only you two can see this 🔒`}</div>`));
  }
  arr.forEach((m) => list.append(msgEl(m)));
  list.scrollTop = list.scrollHeight;
}
function switchChatTab(id) {
  CH.tab = id;
  CH.unread[id] = 0;
  chatOpen(true);
  renderChatTabs(); renderChatList(); renderChatBadge();
  if (id.startsWith('f:')) renderFriends();
  $('#chatInput').focus();
}
function chatOpen(open) {
  $('#chat').classList.toggle('closed', !open);
  if (open) { CH.unread[CH.tab] = 0; renderChatTabs(); renderChatBadge(); const l = $('#chatList'); l.scrollTop = l.scrollHeight; }
}
function pushChat(tab, m) {
  const arr = (CH.msgs[tab] ||= []);
  arr.push(m);
  if (arr.length > 100) arr.shift();
  if (tab.startsWith('f:')) { CH.openF.add(tab); saveDms(); }
  if (!$('#friendRail').hidden && railIsOpen() && FP.tab === 'msgs') renderFriends();
  if (tab !== CH.tab) return;
  const list = $('#chatList');
  list.querySelector('.empty')?.remove();
  list.append(msgEl(m));
  while (list.children.length > 100) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}
function chatLine(html) { pushChat('all', { sys: true, html }); }
function addChat(m, quiet = false) {
  if (m.fdm ? isBlockedFid(m.from) : isBlocked(roomPlayer(m.from))) return; // blocked: their messages never show
  const tab = tabOf(m);
  pushChat(tab, m);
  const mine = m.fdm ? m.from === profile?.fid : m.from === pid;
  if (quiet || mine || (chatIsOpen() && !$('#chat').hidden && CH.tab === tab) || threadVisible(tab)) return;
  CH.unread[tab] = (CH.unread[tab] || 0) + 1;
  renderChatTabs(); renderChatBadge();
  if (!chatIsOpen()) {
    const pk = h(`<div class="pk${m.to ? ' dm' : ''}"><b>${m.to ? '🔒 ' : ''}${esc(m.name)}</b>${esc(m.text.length > 70 ? m.text.slice(0, 70) + '…' : m.text)}</div>`);
    $('#chatPeek').append(pk);
    setTimeout(() => pk.remove(), 3300);
  }
  A.sfx.pop();
}
function resetChat(list = []) {
  // room chat starts fresh, friend conversations stay
  const keep = Object.fromEntries(Object.entries(CH.msgs).filter(([k]) => k.startsWith('f:')));
  const keepU = Object.fromEntries(Object.entries(CH.unread).filter(([k]) => k.startsWith('f:')));
  CH.msgs = { all: [], ...keep }; CH.unread = { all: 0, ...keepU }; CH.tab = 'all';
  list.forEach((m) => addChat(m, true));
  renderChatTabs(); renderChatList(); renderChatBadge();
}
function sendChat(text) {
  if (CH.tab.startsWith('f:')) return N.send({ t: 'fdm', fid: CH.tab.slice(2), text });
  let to = CH.tab === 'all' ? null : CH.tab;
  // "@Name message" from the All tab sends privately
  if (!to && text.startsWith('@')) {
    const body = text.slice(1).toLowerCase();
    const hit = [...chatOthers()].sort((a, b) => b.name.length - a.name.length).find((p) => body.startsWith(p.name.toLowerCase()));
    if (!hit) return toast(`No player called "${text.slice(1).split(' ')[0]}" here`);
    text = text.slice(1 + hit.name.length).trim();
    to = hit.id;
    switchChatTab(hit.id);
    if (!text) return;
  }
  N.send({ t: 'chat', text, ...(to ? { to } : {}) });
}
function setupChat() {
  $('#chatHead').onclick = () => { chatOpen(!chatIsOpen()); if (chatIsOpen()) $('#chatInput').focus(); };
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#chatInput');
    const text = inp.value.trim();
    inp.value = '';
    if (text) sendChat(text);
  };
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.target.blur();
    if (G.screen === 'game') chatOpen(false);
  });
  // Enter anywhere opens the chat and starts typing
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'INPUT') return;
    if (G.screen === 'lobby') { e.preventDefault(); openThread('all'); return; }
    if ($('#chat').hidden) return;
    e.preventDefault();
    chatOpen(true);
    $('#chatInput').focus();
  });
  resetChat();
}

// ---------- voice chat button ----------
function renderMicBtn() {
  const b = $('#micBtn');
  const inRoom = !!G.code;
  b.hidden = !inRoom;
  updateChatVisibility();
  if (!inRoom) return;
  const locked = V.isLocked(), on = V.isOn(), has = V.hasMic();
  b.className = locked ? 'locked' : on && has ? 'on' : 'off';
  b.innerHTML = locked ? '🔒<span>Chat paused – recording</span>' : !has ? '🎙️<span>Enable voice chat</span>' : on ? '🎙️<span>Voice chat on</span>' : '🔇<span>Voice chat off</span>';
}
async function toggleVoice() {
  if (V.isLocked()) return toast('Voice chat is paused while everyone records');
  if (!V.hasMic()) { if (await V.start(pid)) { V.setOn(true); toast('Voice chat on 🎙️'); } else toast('Mic blocked – allow microphone access'); return; }
  V.setOn(!V.isOn());
  A.sfx.click();
}
function setupMicBtn() {
  $('#micBtn').onclick = toggleVoice;
  const told = new Set();
  V.onPeerFail((id) => {
    if (told.has(id)) return;
    told.add(id);
    toast(`🔇 Voice chat couldn't connect to ${nameOf(id)} – their network blocks it`, 4000);
  });
  V.onChange(() => { renderMicBtn(); renderSeats(); });
}

// ---------- ticker ----------
function tick() {
  const out = A.outLevel();
  S.setSpeaker(out);
  if (G.room && G.code) {
    const lv = V.levels();
    G.room.players.forEach((p, i) => {
      if (i === ui.talkIdx) return;
      const l = p.id === pid ? (V.isOn() && !V.isLocked() && V.hasMic() ? Math.min(1, A.micLevel() * 6) : 0) : (lv[p.id] || 0);
      S.setTalk(i, l > 0.08 ? l : 0);
      S.setSpeaking(i, l > 0.12);
      document.querySelectorAll(`.pcard[data-id="${p.id}"], .lslot[data-id="${p.id}"]`).forEach((el) => el.classList.toggle('talking', l > 0.12));
    });
  }
  if (ui.talkIdx >= 0) S.setTalk(ui.talkIdx, ui.talkSrc === 'mic' ? Math.min(1, A.micLevel() * 7) : Math.min(1, out * 5));
  layoutSeats();
  if (ui.micTest) $('#micBar').style.width = `${Math.min(100, A.micLevel() * 500)}%`;
  if (ui.draw) ui.draw();
  requestAnimationFrame(tick);
}

// ---------- phase handlers ----------
function onRoom(room) {
  const prev = G.room;
  if (prev && prev.code === room.code) {
    room.players.forEach((p) => { if (!prev.players.some((x) => x.id === p.id)) chatLine(`👋 ${esc(p.name)} joined`); });
    prev.players.forEach((p) => { if (!room.players.some((x) => x.id === p.id)) chatLine(`🚪 ${esc(p.name)} left`); });
  }
  G.room = room;
  S.setPlayers(room.players, room.phase === 'lobby' ? lobbySeats(room) : null);
  const phase = room.phase;
  if (phase === 'lobby') {
    if (G.screen === 'game' && !G.resultsOpen) showRoomLobby();
    else if (G.screen === 'lobby') renderLobby();
    else if (G.screen !== 'profileScreen' && G.screen !== 'game') showRoomLobby();
  } else {
    if (G.screen !== 'game') { showScreen('game'); S.allHome(); }
    renderCards(G.revealIdx >= 0 ? room.players[G.revealIdx]?.id : null);
    renderPowers(phase === 'announce');
  }
  if (phase !== G.prevPhase) enterPhase(phase);
  G.prevPhase = phase;
}
let phaseSeq = 0;
function caption(text, cls = '') {
  setStage(text ? h(`<div class="caption ${cls}">${text}</div>`) : null);
}
function dim(on) { $('#dim').classList.toggle('show', on); }
function hideScore() { $('#bigScore').hidden = true; }
async function enterPhase(phase) {
  phaseSeq++;
  const r = G.room.round, total = G.room.rounds || ROUNDS;
  if (phase === 'announce') {
    closeModal(); setSide(false); setCenter(false); dim(false); hideScore(); S.stopPick();
    S.showWheel(false); S.allHome(); S.setActive(-1); S.setView('overview');
    cardsVisible(true);
    G.revealIdx = -1; G.recs = {};
    setPhase('ANNOUNCE');
    renderPowers(true);
    caption(`Round ${r} – get ready, a sound is being picked…`);
    await banner(`ROUND ${r}`, r === total ? 'final round!' : `of ${total}`);
  } else if (phase === 'prepare') {
    setPhase('ANNOUNCE');
    renderPowers(false);
  } else if (phase === 'listen') {
    setPhase('REVEAL');
  } else if (phase === 'reveal') {
    setPhase('PLAYBACK');
  } else if (phase === 'spinner') {
    closeModal();
    setPhase('WHEEL');
  } else if (phase === 'final') {
    setPhase('RESULTS');
  }
}
function setCenter(on) { $('#stage').classList.toggle('center', on); }

function rankRows(sorted, extra) {
  const wrap = h(`<div class="rank"></div>`);
  sorted.forEach((p, k) => {
    const row = h(`<div class="rr${p.id === pid ? ' mine' : ''}"><div class="pos">${k + 1}</div><div class="av"></div><div class="rn">${esc(p.name)}</div><div class="rd">${extra(p)}</div><div class="rt">${p.score}</div></div>`);
    $('.av', row).replaceWith(avatarEl(p.look, 48, 48));
    wrap.append(row);
  });
  return wrap;
}

// power-ups: swap / sabotage targets are picked by clicking a character in the room
function onPowerups(m) {
  setPhase('WHEEL');
  S.showWheel(false);
  hideScore();
  const mine = m.choosers.find((c) => c.id === pid);
  S.setView('overview');
  if (!mine) {
    caption('⏳ Power-ups are being used…');
    return;
  }
  const isSwap = mine.kind === 'swap';
  const targets = G.room.players.map((p, i) => ({ p, i })).filter(({ p }) => p.id !== pid && p.connected);
  let done = false;
  const choose = (id) => {
    if (done) return;
    done = true;
    S.stopPick();
    A.sfx.click();
    N.send({ t: 'choice', target: id });
    caption(id ? (isSwap ? '🔄 Swap locked in – it happens after recording' : `${sabInfo(mine.sab).icon} ${esc(nameOf(id))} gets ${sabInfo(mine.sab).name} next round`) : 'Skipped');
  };
  const box = h(`<div class="pickbar">
    <div class="caption">${isSwap ? 'Pick a player: you trade next takes, scores included.' : sabInfo(mine.sab).pick}</div>
    <div class="pick-chips">${targets.map(({ p }) => `<button class="chip" data-id="${p.id}">${esc(p.name)}</button>`).join('')}<button class="chip ghost" data-id="">Skip</button></div>
    <div class="deadline"></div>
  </div>`);
  box.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) choose(b.dataset.id || null); };
  setStage(box);
  S.startPick(targets.map((t) => t.i), (i) => choose(G.room.players[i].id));
  const dl = $('.deadline', box);
  const iv = setInterval(() => {
    const s = Math.ceil((m.deadline - N.serverNow()) / 1000);
    if (done || !dl.isConnected || s < 0) { clearInterval(iv); if (!done && s < 0) S.stopPick(); return; }
    dl.textContent = `click a character · ${s}s`;
  }, 250);
}
function onPowerResult(m) {
  S.stopPick();
  m.results.forEach((r, k) => setTimeout(() => {
    if (r.kind === 'swap') { A.sfx.whoosh(); if (r.from !== pid) toast(`🔄 ${nameOf(r.from)} used SWAP on someone… 👀`); }
  }, k * 900));
}

function onPrepare(m) {
  G.clip = m.clip;
  const ack = () => N.send({ t: 'loaded' });
  A.getClip(m.clip, G.packs).then(ack, ack);
}

// ---------- REVEAL (demo) → 3-2-1 → RECORDING, everyone at the same time ----------
async function onListen(m) {
  const key = G.clip;
  if (!key) return;
  const seq = phaseSeq;
  const myIdx = idxOf(pid);
  const pack = packOf(key), meta = clipMeta(key);
  let buf;
  try { buf = await A.getClip(key, G.packs); } catch { toast('Could not load the sound'); return; }
  const t0 = ctxTimeFor(m.at);
  const demoEnd = t0 + buf.duration;
  const recStart = demoEnd + GAP_AFTER_DEMO;
  const recDur = recDurFor(buf.duration);
  let recEnd = recStart + recDur;
  const sab = (me()?.sabBy || []).length;
  const sabTypes = me()?.sabTypes || [];
  V.setLocked(true);

  // REVEAL: dimmed room, round art, title, pack, waveform
  setPhase('REVEAL');
  cardsVisible(false);
  dim(true);
  S.setActive(-1);
  S.setView('overview');
  setSide(false);
  setCenter(true);
  const W = makeWave(recDur);
  W.ref = buf.getChannelData(0); W.refDur = buf.duration;
  const count = h(`<div class="count-num"></div>`);
  W.wrap.append(count);
  const art = h(packArt(pack, 'reveal-art', true));
  const title = h(`<div class="reveal-block">${art.outerHTML}<div class="clip-title">${esc(meta?.name || 'mystery')}</div><div class="clip-pack">${esc(pack?.name || '')}</div></div>`);
  const cap = h(`<div class="caption">Listen carefully to the demo</div>`);
  const acts = h(`<div class="actions"></div>`);
  setStage(title, W.wrap, cap, acts);
  A.playAt(buf, t0);
  let stage = 'wait', lastCount = 0;
  // stage changes run on a timer (not only in rAF) so they also happen in a background tab
  const step = () => {
    if (!G.code || (seq !== phaseSeq && G.room?.phase !== 'listen')) return;
    const now = A.ctx.currentTime;
    if (now < demoEnd) {
      if (now >= t0 && stage !== 'demo') { stage = 'demo'; cap.textContent = 'Listen carefully to the demo'; }
      W.head = now >= t0 ? (now - t0) / recDur : -1;
    } else if (now < recStart) {
      if (stage !== 'count') {
        // countdown: room un-dims, camera dollies into your character, 3-2-1 on the waveform
        stage = 'count';
        setPhase('RECORDING');
        dim(false);
        title.remove();
        setCenter(false);
        S.setView('self', myIdx);
        S.setActive(myIdx);
        cap.textContent = 'Everyone at once – one shot only!';
      }
      const n = Math.max(1, Math.ceil(recStart - now));
      if (n !== lastCount) { lastCount = n; count.textContent = n; count.classList.remove('pop'); void count.offsetWidth; count.classList.add('pop'); A.sfx.beep(); }
      W.head = -1;
    } else if (now < recEnd) {
      if (stage !== 'rec') {
        stage = 'rec';
        A.sfx.go();
        count.textContent = '';
        cap.className = 'caption rec'; cap.textContent = 'GO!';
        S.setView('selfClose', myIdx);
        S.setExpr(myIdx, 'angry');
        W.live = { start: recStart };
        ui.talkIdx = myIdx; ui.talkSrc = 'mic';
        const done = h(`<button class="btn small yellow">■ DONE</button>`);
        done.onclick = () => { recEnd = Math.min(recEnd, A.ctx.currentTime); done.disabled = true; };
        acts.replaceChildren(done);
      }
      W.head = (now - recStart) / recDur;
    }
  };
  const iv = setInterval(step, 30);
  ui.draw = () => { step(); drawWave(W); };
  // wait for the recording window to close (+ a little for mic latency)
  while (A.ctx.currentTime < recEnd + 0.3 && G.code) await sleep(40);
  clearInterval(iv);
  if (!G.code) return; // left mid-round: nothing to score or upload
  const raw = A.captured(recStart - 0.1, recEnd + 0.2);
  const noise = A.captured(demoEnd + 0.25, recStart - 0.1);
  V.setLocked(false);
  S.setExpr(myIdx, 'neutral');
  ui.talkIdx = -1; S.setTalk(myIdx, 0);
  const sr = A.ctx.sampleRate;
  const samples = sab ? A.applySabotages(raw, sr, sabTypes) : raw;
  W.live = null; W.head = -1;
  W.rec = samples.subarray(Math.round(0.1 * sr)); W.recDur = W.rec.length / sr; W.cache.clear(); // skip the 0.1 s pre-roll
  acts.replaceChildren();
  cap.className = 'caption'; cap.textContent = 'Nice! Waiting for everyone…';

  // nothing said = 0, no matter what the room noise looks like
  const va = voiceActivity(raw, sr, noise);
  let res;
  if (!A.micReady() || !va.speech) res = { pct: 0, pitch: 0, rhythm: 0, tone: 0, note: 'silent' };
  else res = await scoreMimic(buf, A.toBuffer(sab ? A.applySabotages(va.trimmed, sr, sabTypes) : va.trimmed, sr));
  if (sab && res.note !== 'silent') {
    const clean = await scoreMimic(buf, A.toBuffer(va.trimmed, sr));
    res.pct = Math.max(res.pct, Math.round(clean.pct * 0.45));
  }
  let hasRec = false;
  try {
    const wav = await A.encodeWav(samples, sr);
    const r = await fetch(`/api/rec/${G.room.code}/${G.room.round}/${pid}`, { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } });
    hasRec = r.ok;
  } catch {}
  N.send({ t: 'submit', sub: { pct: res.pct, pitch: res.pitch, rhythm: res.rhythm, tone: res.tone, note: res.note, recDur: samples.length / sr, hasRec } });
  ui.draw = () => drawWave(W);
}

// ---------- PLAYBACK: one by one at the mic, same on every screen ----------
function onRevealStart(m) {
  G.recs = {};
  closeModal(); setCenter(false); dim(false);
  setStage(); ui.draw = null;
  cardsVisible(true);
  setPhase('PLAYBACK');
  S.setActive(-1);
  S.setView('overview');
  m.recs.forEach((id) => { G.recs[id] = A.fetchBuffer(`/api/rec/${G.room.code}/${G.room.round}/${id}`).catch(() => null); });
}
let revealToken = 0;
async function onReveal(m) {
  const token = ++revealToken;
  const i = idxOf(m.pid);
  if (G.revealIdx >= 0 && G.revealIdx !== i) { S.walkHome(G.revealIdx); S.setSinging(G.revealIdx, false); }
  G.revealIdx = i;
  const p = G.room.players[i];
  hideScore();
  renderCards(m.pid);
  S.setActive(i);
  S.walkToMic(i);
  S.setView('overview');
  setSide(false);
  const rec = await (G.recs[m.recOf] || null);
  if (token !== revealToken) return;
  const throwBar = m.pid !== pid ? h(`<div class="throw-bar">${THROWABLES.map((t) => `<button class="tb" data-k="${t.kind}" title="Throw a ${t.label.toLowerCase()}">${t.icon}</button>`).join('')}</div>`) : null;
  if (throwBar) throwBar.onclick = (e) => { const b = e.target.closest('.tb'); if (b) N.send({ t: 'throw', to: m.pid, item: b.dataset.k }); };
  setStage(m.swappedWith ? h(`<div class="swap-tag">🔄 SWAPPED – ${esc(p.name)} got ${esc(nameOf(m.recOf))}'s take!</div>`) : null, throwBar);

  const tRec = ctxTimeFor(m.at);
  await waitUntil(tRec - 0.05);
  if (token !== revealToken) return;
  if (rec) {
    if (m.swappedWith) A.sfx.whoosh();
    ui.talkIdx = i; ui.talkSrc = 'out';
    S.setSinging(i, true);
    A.playAt(rec, tRec);
    await waitUntil(tRec + rec.duration + 0.35);
  } else await sleep(700);
  if (token !== revealToken) return;
  ui.talkIdx = -1; S.setTalk(i, 0); S.setSinging(i, false);

  // the big "NN / 100" under the mic, coloured by score, bonus line under it
  const sub = m.sub || {};
  const pct = Math.round(sub.pct || 0);
  const color = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'bad';
  const bonus = m.bonus?.kind === 'add' ? `Bonus: +${m.bonus.value}` : m.bonus?.kind === 'mult' ? 'Bonus: ×1.5' : '';
  const silent = sub.note === 'silent' || sub.note === 'missing';
  const box = $('#bigScore');
  box.className = color;
  box.innerHTML = `<div class="bs-num"><span>0</span> / 100</div>${bonus ? `<div class="bs-sub">${bonus}</div>` : ''}${silent ? '<div class="bs-sub">no voice heard 🤐</div>' : ''}`;
  box.hidden = false;
  const num = $('.bs-num span', box);
  for (let k = 0; k <= pct; k += Math.max(1, Math.round(pct / 25))) { if (token !== revealToken) return; num.textContent = k; A.sfx.count(); await sleep(28); }
  num.textContent = pct;
  if (pct >= 60) { A.sfx.ding(Math.floor(pct / 30)); S.setMood(i, 'happy', 2.2); }
  else { A.sfx.sad(); S.setMood(i, 'sad', 2.2); }
  if (pct >= 80) S.confetti(0);
  if (pct >= 90) { S.setView('punch'); setTimeout(() => { if (token === revealToken) S.setView('overview'); }, 1800); }
  // the crowd reacts: bad mimic = incoming bottles, shoes and stones
  (m.volley || []).forEach((v, k) => setTimeout(() => {
    if (token !== revealToken) return;
    S.throwItem(v.from ? idxOf(v.from) : -1, i, v.item); A.sfx.toss();
  }, 250 + k * 220));
}
const waitUntil = async (t) => { while (A.ctx.currentTime < t) await sleep(20); };
function onThrow(m) {
  const to = idxOf(m.to), from = idxOf(m.from);
  if (to < 0) return;
  S.throwItem(from, to, m.item);
  A.sfx.toss();
}

// ---------- SPIN: everybody spins their own wheel at the same time ----------
function onWheel(m) {
  revealToken++;
  G.segs = m.segs;
  closeModal(); hideScore(); ui.draw = null;
  if (G.revealIdx >= 0) { S.walkHome(G.revealIdx); S.setSinging(G.revealIdx, false); }
  G.revealIdx = -1;
  setPhase('WHEEL');
  cardsVisible(true);
  S.setWheelSegments(m.segs);
  S.showWheel(true);
  S.setActive(-1);
  S.setView('wheel');
  setSide(false);
  const cta = h(`<div class="spin-cta"><button class="btn big yellow" data-primary>SPIN!</button><div class="deadline"></div></div>`);
  $('button', cta).onclick = (e) => { e.target.disabled = true; A.sfx.click(); N.send({ t: 'spin' }); };
  setStage(cta);
  const dl = $('.deadline', cta);
  const iv = setInterval(() => {
    const s = Math.ceil((m.deadline - N.serverNow()) / 1000);
    if (!dl.isConnected || s < 0) return clearInterval(iv);
    dl.textContent = `auto-spin in ${s}s`;
  }, 250);
}
async function onSpin(m) {
  const seq = phaseSeq;
  caption('Spinning…');
  await S.spinWheel(m.index, A.sfx.tick);
  if (seq !== phaseSeq) return;
  const seg = G.segs[m.index];
  if (seg.kind === 'sabotage') A.sfx.glitch(); else A.sfx.ding(2);
  S.setMood(idxOf(pid), seg.kind === 'add' && seg.value === 1 ? 'sad' : 'happy', 1.8);
  S.setView('wheelZoom');
  const solo = (seg.kind === 'swap' || seg.kind === 'sabotage') && G.room.players.filter((p) => p.connected).length < 2;
  setStage(h(`<div class="prize"><div class="big">${esc(seg.title || seg.label)}</div><div class="desc">${solo ? 'No rivals to hit in a solo game – you get +5 instead!' : esc(seg.desc)}</div></div>`));
}

// ---------- RESULTS ----------
// Leaving mid-match: silence whatever the round was playing and cancel its pending steps, so no demo,
// take or talking mouth follows you into the lobby, the home screen or the player editor.
function stopMatch() {
  phaseSeq++; revealToken++;
  A.stopPlayback();
  ui.talkIdx = -1; ui.draw = null;
  V.setLocked(false);
  S.stopPick(); S.showWheel(false); S.setActive(-1);
  setStage(); setSide(false); setCenter(false); hideScore(); dim(false);
  G.room = null; G.clip = null; G.recs = {};
}
function leaveToMenu() {
  stopMatch();
  N.send({ t: 'leave' }); V.leaveAll();
  G.code = null; G.resultsOpen = false;
  history.replaceState(null, '', location.pathname);
  $('#results').hidden = true;
  renderMicBtn();
  showHome();
}
async function onFinal(m) {
  revealToken++;
  setStage(); setSide(false); hideScore(); dim(false); ui.draw = null;
  S.showWheel(false); S.allHome();
  const P = G.room.players;
  const ranking = m.ranking.map((r) => ({ ...P.find((p) => p.id === r.id), ...r })).filter((p) => p.name);
  const winner = ranking[0];
  const mine = ranking.find((r) => r.id === pid);
  if (mine && profile) {
    profile.xp = (profile.xp || 0) + mine.score;
    profile.games = (profile.games || 0) + 1;
    if (winner.id === pid) profile.wins = (profile.wins || 0) + 1;
    saveProfile(); N.setHello(helloMsg());
  }
  A.sfx.fanfare();
  G.resultsOpen = true;
  const scr = $('#results');
  scr.hidden = false;
  const stats = m.stats || {};
  // 1) what did you think of these packs?
  const packs = (stats.packs || []).map((id) => G.packs.find((p) => p.id === id)).filter(Boolean);
  const vote = (packId, kind, btn) => {
    btn.classList.add('on'); btn.disabled = true;
    fetch('/api/pack-feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: packId, kind, voter: pid }) }).catch(() => {});
  };
  const showRanking = () => {
    const box = h(`<div class="res-wrap">
      <h1 class="res-title">RESULTS</h1>
      <div class="podium"></div>
      <div class="res-stats">
        ${stats.best ? `<div>Best imitation: ${esc(stats.best.name)} (${stats.best.pts})</div>` : ''}
        <div>Click PLAY AGAIN to keep going with this table. No answer sends you to the menu.</div>
      </div>
      <button class="btn big green" id="btnAgain" data-primary>PLAY AGAIN (35)</button>
      <button class="btn ghost" id="btnMenu">BACK TO MENU</button>
    </div>`);
    ranking.forEach((p, k) => {
      const c = h(`<div class="pod${k === 0 ? ' first' : ''}"><div class="pos">${k + 1}</div><div class="pcard"></div></div>`);
      const card = $('.pcard', c);
      card.append(h(`<div class="pn">${esc(p.name)}</div>`), h(`<div class="sc">${p.score}</div>`), avatarEl(p.look, 112, 76));
      $('.podium', box).append(c);
    });
    scr.replaceChildren(box);
    let left = 35;
    const btn = $('#btnAgain', box);
    const iv = setInterval(() => {
      left--;
      if (!btn.isConnected) return clearInterval(iv);
      btn.textContent = `PLAY AGAIN (${left})`;
      if (left <= 0) { clearInterval(iv); leaveToMenu(); }
    }, 1000);
    btn.onclick = () => {
      clearInterval(iv);
      G.resultsOpen = false;
      scr.hidden = true;
      A.sfx.click();
      if (!isHost()) N.send({ t: 'ready', v: true });
      P.forEach((_, i) => S.setMood(i, 'idle', 0));
      showRoomLobby();
    };
    $('#btnMenu', box).onclick = () => { clearInterval(iv); leaveToMenu(); };
  };
  if (!packs.length) return showRanking();
  const fb = h(`<div class="res-wrap">
    <h1 class="res-title">RESULTS</h1>
    <div class="panel fb">
      <h3>What did you think of these Packs?</h3>
      <p>Optional: your take helps put the good packs forward.</p>
      <div class="fb-rows"></div>
      <button class="btn big blue" id="btnGo" data-primary>GO</button>
    </div>
    <button class="btn ghost" id="btnMenu">BACK TO MENU</button>
  </div>`);
  packs.forEach((pk) => {
    const row = h(`<div class="fb-row">${packArt(pk, 'fb-ic')}<b>${esc(pk.name)}</b><button class="fb-like">❤ LIKE</button><button class="fb-rep">! REPORT</button></div>`);
    $('.fb-like', row).onclick = (e) => vote(pk.id, 'like', e.currentTarget);
    $('.fb-rep', row).onclick = (e) => vote(pk.id, 'report', e.currentTarget);
    $('.fb-rows', fb).append(row);
  });
  scr.replaceChildren(fb);
  $('#btnGo', fb).onclick = () => { A.sfx.click(); showRanking(); };
  $('#btnMenu', fb).onclick = leaveToMenu;
}

// ---------- settings (Esc) + quit ----------
function openSettings(tab = 'options') {
  if (!G.code) return;
  const box = h(`<div class="panel mbox settings-modal">
    <h2 class="title-3d" style="font-size:44px">Settings</h2>
    <div class="tabs"><button data-tab="options">OPTIONS</button><button data-tab="match">MATCH</button></div>
    <div class="tab-body"></div>
    <button class="btn blue" data-primary id="btnResume">RESUME</button>
  </div>`);
  const body = $('.tab-body', box);
  const render = (t) => {
    box.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    body.replaceChildren();
    if (t === 'options') {
      const game = h(`<label class="srow"><span>Game volume</span><input type="range" min="0" max="100" value="${Math.round(A.master.gain.value / 0.9 * 100)}" /><b></b></label>`);
      const chat = h(`<label class="srow"><span>Voice chat volume</span><input type="range" min="0" max="100" value="${Math.round(V.getChatVolume() * 100)}" /><b></b></label>`);
      const mic = h(`<div class="srow"><span>My mic in voice chat</span><button class="btn small ${V.isOn() ? 'green' : 'ghost'}">${V.isOn() ? 'ON' : 'OFF'}</button></div>`);
      const sync = (row, fn) => { const r = $('input', row), b = $('b', row); const u = () => { b.textContent = `${r.value}%`; fn(r.value / 100); }; r.oninput = u; u(); };
      sync(game, (v) => { A.master.gain.value = 0.9 * v; localStorage.setItem('mv_vol', v); });
      sync(chat, (v) => V.setChatVolume(v));
      $('button', mic).onclick = () => { V.setOn(!V.isOn()); render('options'); };
      body.append(game, chat, mic);
    } else {
      const others = G.room.players.filter((p) => p.id !== pid);
      if (!others.length) body.append(h(`<p>No one else here yet.</p>`));
      others.forEach((p) => {
        const row = h(`<div class="srow"><span>${esc(p.name)}</span><input type="range" min="0" max="100" value="${Math.round(V.getPeerVolume(p.id) * 100)}" /><b></b></div>`);
        const r = $('input', row), b = $('b', row);
        const u = () => { b.textContent = `${r.value}%`; V.setPeerVolume(p.id, r.value / 100); };
        r.oninput = u; u();
        body.append(row);
      });
    }
  };
  box.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => render(b.dataset.tab); });
  $('#btnResume', box).onclick = closeModal;
  render(tab);
  openModal(box);
}
function setupHudButtons() {
  // in a match: right-click a character for add friend / report / block
  $('#gl').addEventListener('contextmenu', (e) => {
    if (G.screen !== 'game' || !G.room) return;
    e.preventDefault();
    const i = S.charIndexAt(e);
    if (i >= 0) playerMenu(G.room.players[i], e.clientX, e.clientY);
  });
  $('#btnSettings').onclick = () => openSettings();
  $('#btnQuit').onclick = () => {
    const box = h(`<div class="panel mbox"><h2>Leave the game?</h2><p>Your score stays with the others, you go back to the menu.</p><div class="actions"><button class="btn ghost" id="qNo" data-primary>STAY</button><button class="btn pink" id="qYes">QUIT</button></div></div>`);
    $('#qNo', box).onclick = closeModal;
    $('#qYes', box).onclick = () => { closeModal(); leaveToMenu(); };
    openModal(box);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.tagName === 'INPUT') return;
    if (!$('#modal').hidden) { closeModal(); return; }
    openSettings();
  });
  const v = parseFloat(localStorage.getItem('mv_vol'));
  if (!Number.isNaN(v)) A.master.gain.value = 0.9 * v;
}

// ---------- network ----------
// match messages that were already on their way when you left the room are dropped
const MATCH_MSGS = new Set(['prepare', 'listen', 'revealStart', 'reveal', 'throw', 'wheel', 'spin', 'powerups', 'powerResult', 'final']);
function onMessage(m) {
  if (!G.code && MATCH_MSGS.has(m.t)) return;
  switch (m.t) {
    case 'net':
      $('#netDot').classList.toggle('down', !m.up);
      if (!m.up) toast('Connection lost – reconnecting…');
      break;
    case 'packs':
      G.packs = m.packs;
      if (G.screen === 'lobby') renderLobby();
      break;
    case 'joined':
      G.code = m.code;
      history.replaceState(null, '', `?room=${m.code}`);
      if (G.screen !== 'game') showRoomLobby();
      renderMicBtn();
      if (pendingInvite) { N.send({ t: 'invite', fid: pendingInvite }); pendingInvite = null; }
      break;
    case 'error': toast(m.msg, 3200); break;
    case 'room': onRoom(m.room); V.syncPeers(m.room.players); applyBlocks(); renderMicBtn(); renderChatTabs(); break;
    case 'chat': addChat(m); break;
    case 'rooms': renderRoomList(m.list); break;
    case 'friendsStatus':
      m.list.forEach((st) => friendStatus.set(st.fid, st));
      m.list.filter((st) => st.online && outgoing.some((o) => o.fid === st.fid)).forEach((st) => N.send({ t: 'friendAdd', fid: st.fid }));
      renderFriends();
      if (G.screen === 'homeScreen') S.setPlayers(homeStagePlayers());
      break;
    case 'friendInfo': onFriendInfo(m); break;
    case 'friendRequest': onFriendRequest(m); break;
    case 'invite': onInvite(m); break;
    case 'joinReq': onJoinReq(m); break;
    case 'joinReqResult': onJoinReqResult(m); break;
    case 'fdm': addChat({ ...m, fdm: true, name: m.from === profile?.fid ? profile.name : m.fromName }); renderFriends(); break;
    case 'chatHistory': resetChat(m.list); break;
    case 'rtc': V.onSignal(m.from, m.data).catch((e) => console.warn('rtc', e)); break;
    case 'ice': V.setIce(m.servers); break;
    case 'left': stopMatch(); G.code = null; V.leaveAll(); history.replaceState(null, '', location.pathname); $('#joinCode').value = ''; renderMicBtn(); showHome(); break;
    case 'powerups': onPowerups(m); break;
    case 'powerResult': onPowerResult(m); break;
    case 'prepare': onPrepare(m); break;
    case 'listen': onListen(m).catch((e) => { console.error(e); toast('Recording failed'); }); break;
    case 'revealStart': onRevealStart(m); break;
    case 'reveal': onReveal(m).catch(console.error); break;
    case 'throw': onThrow(m); break;
    case 'wheel': onWheel(m); break;
    case 'spin': onSpin(m); break;
    case 'final': onFinal(m); break;
  }
}

// ---------- boot ----------
(async () => {
  await S.initScene($('#gl'));
  S.setHooks({ onStep: () => A.sfx.step(), onHit: (k) => A.sfx.hit(k) });
  setupHome();
  setupLobby();
  setupMicBtn();
  setupChat();
  setupHudButtons();
  setupSocial();
  ensureFid();
  N.connect(helloMsg(), onMessage);
  $('#boot').classList.add('gone');
  if (!profile) showProfile(); else showHome();
  tick();
})();
