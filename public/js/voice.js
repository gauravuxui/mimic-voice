// Real-time voice chat: WebRTC audio mesh between the players of a room, signalled over
// the game WebSocket. The mic can be toggled by the player and is force-muted (both ways)
// by the game while everyone is listening to the demo and recording.
import * as N from './net.js';
import { ctx } from './audio.js';

// STUN until the server sends its list (which adds a TURN relay when one is configured)
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
export function setIce(servers) { if (Array.isArray(servers) && servers.length) ICE = servers; }
let failHook = null;
export function onPeerFail(fn) { failHook = fn; }
let myId = null, stream = null, track = null;
let wantOn = localStorage.getItem('mv_chat') !== 'off';
let locked = false;
const peers = new Map(); // id -> { pc, audio, analyser, pendingIce, remoteSet }
const listeners = new Set();
// volumes: whole voice chat and per player (settings → MATCH)
let chatVol = parseFloat(localStorage.getItem('mv_chatvol'));
if (Number.isNaN(chatVol)) chatVol = 1;
const peerVol = new Map();
const volFor = (id) => Math.max(0, Math.min(1, chatVol * (peerVol.get(id) ?? 1)));
export const getChatVolume = () => chatVol;
export const getPeerVolume = (id) => peerVol.get(id) ?? 1;
export function setChatVolume(v) { chatVol = v; localStorage.setItem('mv_chatvol', v); peers.forEach((p, id) => { if (p.audio) p.audio.volume = volFor(id); }); }
export function setPeerVolume(id, v) { peerVol.set(id, v); const p = peers.get(id); if (p?.audio) p.audio.volume = volFor(id); }
const tbuf = new Float32Array(512);

export const isOn = () => wantOn;
export const isLocked = () => locked;
export const hasMic = () => !!track;
export function onChange(fn) { listeners.add(fn); }
const changed = () => listeners.forEach((fn) => fn());

// separate getUserMedia with echo cancellation – the game recorder keeps its raw mic
export async function start(id) {
  myId = id;
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // own clone, so muting chat can never silence the game recorder
    track = stream.getAudioTracks()[0].clone();
    stream = new MediaStream([track]);
    apply();
    // add the new track to already-open connections
    for (const pid of peers.keys()) offer(pid); // renegotiate so the others start hearing us
    changed();
    return true;
  } catch (e) {
    console.warn('voice chat mic unavailable', e);
    return false;
  }
}
function apply() {
  if (track) track.enabled = wantOn && !locked;
  peers.forEach((p) => { if (p.audio) p.audio.muted = locked; });
}
export function setOn(on) {
  wantOn = on;
  localStorage.setItem('mv_chat', on ? 'on' : 'off');
  apply();
  N.send({ t: 'mic', on });
  changed();
}
export function setLocked(l) {
  if (locked === l) return;
  locked = l;
  apply();
  changed();
}

function makePeer(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const p = { pc, audio: null, analyser: null, pendingIce: [], remoteSet: false };
  if (track) pc.addTrack(track, stream);
  else pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.onicecandidate = (e) => { if (e.candidate) N.send({ t: 'rtc', to: id, data: { type: 'ice', candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    const s = e.streams[0] || new MediaStream([e.track]);
    if (!p.audio) {
      p.audio = new Audio();
      p.audio.autoplay = true;
      p.audio.muted = locked;
    }
    p.audio.volume = volFor(id);
    p.audio.srcObject = s;
    p.audio.play().catch(() => {});
    try {
      const src = ctx.createMediaStreamSource(s);
      p.analyser = ctx.createAnalyser();
      p.analyser.fftSize = 512;
      src.connect(p.analyser);
    } catch {}
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState !== 'failed') return;
    if (!p.retried && myId < id) setTimeout(() => { if (peers.get(id)?.pc === pc) { const np = makePeer(id); np.retried = true; offer(id); } }, 1500);
    else if (failHook) failHook(id); // tried twice (or it's their turn to retry and it still failed)
  };
  peers.set(id, p);
  return p;
}
function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  try { p.pc.close(); } catch {}
  if (p.audio) { p.audio.srcObject = null; }
  peers.delete(id);
}
async function offer(id) {
  const p = peers.get(id);
  if (!p) return;
  const o = await p.pc.createOffer();
  await p.pc.setLocalDescription(o);
  N.send({ t: 'rtc', to: id, data: { type: 'offer', sdp: p.pc.localDescription } });
}

// keep one connection per other connected player; the lower id makes the offer
export function syncPeers(players) {
  if (!myId) return;
  const ids = players.filter((p) => p.connected && p.id !== myId && !p.bot).map((p) => p.id);
  for (const id of [...peers.keys()]) if (!ids.includes(id)) closePeer(id);
  for (const id of ids) if (!peers.has(id) && myId < id) { makePeer(id); offer(id); }
}
export function leaveAll() { for (const id of [...peers.keys()]) closePeer(id); }

export async function onSignal(from, data) {
  let p = peers.get(from);
  if (data.type === 'offer') {
    p = makePeer(from); // a new offer always means a fresh connection from the other side
    await p.pc.setRemoteDescription(data.sdp);
    p.remoteSet = true;
    for (const c of p.pendingIce) await p.pc.addIceCandidate(c).catch(() => {});
    p.pendingIce = [];
    const a = await p.pc.createAnswer();
    await p.pc.setLocalDescription(a);
    N.send({ t: 'rtc', to: from, data: { type: 'answer', sdp: p.pc.localDescription } });
  } else if (data.type === 'answer' && p) {
    await p.pc.setRemoteDescription(data.sdp).catch(() => {});
    p.remoteSet = true;
    for (const c of p.pendingIce) await p.pc.addIceCandidate(c).catch(() => {});
    p.pendingIce = [];
  } else if (data.type === 'ice' && p) {
    if (p.remoteSet) await p.pc.addIceCandidate(data.candidate).catch(() => {});
    else p.pendingIce.push(data.candidate);
  }
}

// voice level (0..1) of every remote player, for the talking animation
export function levels() {
  const out = {};
  for (const [id, p] of peers) {
    if (!p.analyser || locked) { out[id] = 0; continue; }
    p.analyser.getFloatTimeDomainData(tbuf);
    let s = 0;
    for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
    out[id] = Math.min(1, Math.sqrt(s / tbuf.length) * 6);
  }
  return out;
}
