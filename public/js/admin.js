// Admin panel: manage uploaded sound packs. Every change is pushed live to all players.
import * as A from './audio.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let key = localStorage.getItem('mv_admin') || '';
let packs = [];
let stats = {};
const statTxt = (id) => { const st = stats[id]; return st ? ` · ❤ ${st.likes} · ! ${st.reports}` : ''; };

let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
async function api(path, opts = {}) {
  const r = await fetch(`/api/admin/${path}`, { ...opts, headers: { 'x-admin-key': key, ...(opts.json ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error || r.statusText); err.status = r.status; throw err; }
  return data;
}

// covers are shrunk in the browser (max 512px, webp) so uploads stay small and metadata is dropped
async function shrinkImage(file, max = 512) {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('not an image this browser can read'); });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not convert the image'))), 'image/webp', 0.85));
}
async function uploadImage(packId, file) {
  const blob = await shrinkImage(file);
  await api(`packs/${packId}/image`, { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
}
const isImage = (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name);

function renderLogin(msg = '') {
  $('#app').replaceChildren(h(`<form class="panel login">
    <h1 class="title-3d" style="font-size:56px">Admin</h1>
    <p>Enter the admin key. It's printed in the server console and saved in <code>data/admin-key.txt</code>.</p>
    <input id="key" type="password" placeholder="Admin key" autocomplete="current-password" />
    <div class="status" style="color:#ff8a8a">${esc(msg)}</div>
    <button class="btn green" style="margin-top:10px;width:100%">ENTER</button>
  </form>`));
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    key = $('#key').value.trim();
    try { await api('check'); localStorage.setItem('mv_admin', key); load(); }
    catch (err) { renderLogin(err.status === 401 ? 'Wrong key' : 'The server is waking up – try again in a few seconds'); }
  };
  $('#key').focus();
}

// the saved key is only dropped when the server says it's wrong – a sleeping or
// redeploying server (free hosting) just means "wait and try again"
async function load(tries = 0) {
  try { packs = await api('packs'); stats = await api('pack-stats').catch(() => ({})); }
  catch (err) {
    if (err.status === 401) { localStorage.removeItem('mv_admin'); return renderLogin('That key no longer works – enter the current one'); }
    $('#app').replaceChildren(h(`<div class="panel login"><h1 class="title-3d" style="font-size:44px">Admin</h1><p>Server is waking up… (${tries + 1})</p></div>`));
    return setTimeout(() => load(tries + 1), Math.min(10000, 2000 + tries * 1000));
  }
  render();
}

function render() {
  const app = $('#app');
  app.replaceChildren();
  app.append(h(`<div class="top"><h1 class="title-3d">Sound Packs</h1><a href="/">← back to game</a></div>`));
  const np = h(`<form class="panel newpack">
    <input name="name" placeholder="New pack name (e.g. Indian Memes)" maxlength="40" required />
    <input name="icon" placeholder="Emoji" maxlength="4" value="🎵" />
    <input name="color" type="color" value="#c9772f" />
    <label class="pick-img" title="Pack image (optional)">🖼<span>Image</span><input name="image" type="file" accept="image/*" hidden /></label>
    <button class="btn green small">＋ CREATE PACK</button>
  </form>`);
  const pick = $('.pick-img', np), pickInput = $('input[type=file]', np);
  pickInput.onchange = () => { const f = pickInput.files[0]; pick.classList.toggle('has', !!f); $('span', pick).textContent = f ? f.name.slice(0, 14) : 'Image'; };
  np.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(np);
    const pack = await api('packs', { method: 'POST', json: { name: f.get('name'), icon: f.get('icon'), color: f.get('color') } });
    const img = pickInput.files[0];
    if (img) await uploadImage(pack.id, img).catch((err) => toast(`Image: ${err.message}`, 4000));
    toast('Pack created – now drop some sounds in it');
    load();
  };
  app.append(np);
  if (!packs.length) app.append(h(`<div class="empty">No uploaded packs yet. Create one above, then drop audio files into it.</div>`));
  packs.forEach((p) => app.append(packCard(p)));
}

function packCard(p) {
  const el = h(`<div class="panel pack">
    <div class="pack-head">
      ${p.image
        ? `<button class="icon pic" style="background-color:${esc(p.color)};background-image:url('/media/${esc(p.id)}/${esc(p.image)}')" title="Change image"></button>`
        : `<input class="icon" value="${esc(p.icon)}" maxlength="4" style="background:${esc(p.color)}" title="Emoji icon (or add an image)" />`}
      <input class="name" value="${esc(p.name)}" maxlength="40" />
      <input type="color" value="${esc(p.color)}" title="Pack colour" />
      <label class="toggle"><input type="checkbox" class="chk" ${p.enabled !== false ? 'checked' : ''} /> live<span>${statTxt(p.id)}</span></label>
      <span class="img-btns"><button class="ib img" title="${p.image ? 'Change' : 'Add'} pack image">🖼</button>${p.image ? '<button class="ib unimg" title="Remove image (back to the emoji)">✕</button>' : ''}</span>
      <button class="ib del" title="Delete pack">🗑</button>
    </div>
    <input type="file" class="img-file" accept="image/*" hidden />
    <div class="clips"></div>
    <div class="drop">🎵 Drop audio files here or click to upload (mp3, wav, ogg, m4a…) – max 6s each, silence gets trimmed<br><small>Drop an image here to use it as the pack picture</small></div>
    <input type="file" class="audio-file" accept="audio/*" multiple hidden />
    <div class="status"></div>
  </div>`);
  const patch = (json) => api(`packs/${p.id}`, { method: 'PATCH', json }).then(() => toast('Saved – players updated')).catch((e) => toast(e.message));
  const imgFile = $('.img-file', el);
  const setImage = async (file) => {
    try { await uploadImage(p.id, file); toast('Pack image saved – players updated'); load(); }
    catch (err) { toast(`Image: ${err.message}`, 4000); }
  };
  $('.img', el).onclick = () => imgFile.click();
  if (p.image) $('.icon', el).onclick = () => imgFile.click();
  imgFile.onchange = () => imgFile.files[0] && setImage(imgFile.files[0]);
  if (p.image) $('.unimg', el).onclick = async () => { await api(`packs/${p.id}/image`, { method: 'DELETE' }); toast('Image removed'); load(); };
  if (!p.image) $('.icon', el).onchange = (e) => patch({ icon: e.target.value });
  $('.name', el).onchange = (e) => patch({ name: e.target.value });
  $('input[type=color]', el).onchange = (e) => { $('.icon', el).style.background = e.target.value; patch({ color: e.target.value }); };
  $('.chk', el).onchange = (e) => patch({ enabled: e.target.checked });
  $('.del', el).onclick = async () => {
    if (!confirm(`Delete "${p.name}" and all ${p.clips.length} sounds? This can't be undone.`)) return;
    await api(`packs/${p.id}`, { method: 'DELETE' });
    toast('Pack deleted');
    load();
  };
  const list = $('.clips', el);
  if (!p.clips.length) list.append(h(`<div class="empty">No sounds yet.</div>`));
  p.clips.forEach((c) => {
    const row = h(`<div class="clip">
      <button class="ib play" title="Play">▶</button>
      <input value="${esc(c.name)}" maxlength="40" />
      <select title="Difficulty">${[1, 2, 3].map((s) => `<option value="${s}" ${c.stars === s ? 'selected' : ''}>${'★'.repeat(s)}${'☆'.repeat(3 - s)}</option>`).join('')}</select>
      <span class="dur">${c.dur.toFixed(1)}s</span>
      <button class="ib del" title="Delete">✕</button>
    </div>`);
    $('.play', row).onclick = async () => { await A.resume(); A.playBuffer(await A.fetchBuffer(`/media/${p.id}/${c.file}`)); };
    $('input', row).onchange = (e) => api(`packs/${p.id}/clips/${c.id}`, { method: 'PATCH', json: { name: e.target.value } }).then(() => toast('Renamed'));
    $('select', row).onchange = (e) => api(`packs/${p.id}/clips/${c.id}`, { method: 'PATCH', json: { stars: +e.target.value } }).then(() => toast('Saved'));
    $('.del', row).onclick = async () => { await api(`packs/${p.id}/clips/${c.id}`, { method: 'DELETE' }); load(); };
    list.append(row);
  });
  const drop = $('.drop', el), input = $('.audio-file', el), status = $('.status', el);
  const upload = async (files) => {
    files = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|webm|flac)$/i.test(f.name));
    let ok = 0;
    for (const f of files) {
      status.textContent = `Uploading ${f.name}… (${ok + 1}/${files.length})`;
      try {
        await A.resume();
        const buf = await A.decodeUpload(f);
        const wav = await A.encodeWav(buf.getChannelData(0), buf.sampleRate, 44100);
        const name = f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sound';
        await api(`packs/${p.id}/clips`, { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav', 'x-clip-name': encodeURIComponent(name), 'x-dur': buf.duration.toFixed(3) } });
        ok++;
      } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
    }
    status.textContent = '';
    if (ok) { toast(`Uploaded ${ok} sound${ok > 1 ? 's' : ''} – live for all players`); load(); }
  };
  drop.onclick = () => input.click();
  input.onchange = () => upload(input.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const files = [...e.dataTransfer.files];
    const img = files.find(isImage);
    if (img) setImage(img);
    const audio = files.filter((f) => !isImage(f));
    if (audio.length) upload(audio);
  };
  return el;
}

if (key) load(); else renderLogin();
