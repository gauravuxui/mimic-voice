// Durable storage for uploaded packs on hosts whose disk is wiped on every restart (e.g. Render's free plan).
// The data folder is mirrored to a private GitHub repo: pulled once at startup, and every file the server
// writes or deletes is pushed back through the GitHub API, one queued call at a time.
// Without GITHUB_DATA_REPO + GITHUB_TOKEN everything stays on the local disk only.
import fsp from 'node:fs/promises';
import path from 'node:path';

const PRIVATE = new Set(['admin-key.txt']); // secrets never leave the server

export function createStore({ dataDir, repo, token, apiUrl = 'https://api.github.com', log = console }) {
  const enabled = !!(repo && token);
  const shas = new Map(); // repo path -> blob sha (GitHub needs it to update or delete a file)
  const timers = new Map();
  let branch = null;
  let queue = Promise.resolve();

  const gh = async (method, url, body) => {
    const r = await fetch(apiUrl + url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mimic-voice',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
  const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/');
  const onBranch = () => (branch ? { branch } : {});
  const run = (job) => (queue = queue.then(job).catch((e) => log.error(`[store] ${e.message}`)));
  const currentSha = async (rel) => (await gh('GET', `/repos/${repo}/contents/${enc(rel)}${branch ? `?ref=${branch}` : ''}`)).data?.sha;

  // download the whole repo into the data folder (startup only)
  async function pull() {
    if (!enabled) return;
    const info = await gh('GET', `/repos/${repo}`);
    if (info.status !== 200) throw new Error(`can't open ${repo} (${info.status} ${info.data.message || ''}) – check GITHUB_DATA_REPO and the token`);
    const tree = await gh('GET', `/repos/${repo}/git/trees/${encodeURIComponent(info.data.default_branch)}?recursive=1`);
    if (tree.status === 409) { log.log(`[store] ${repo} is empty – starting fresh`); return; }
    if (tree.status !== 200) throw new Error(`can't list ${repo} (${tree.status})`);
    branch = info.data.default_branch;
    const files = tree.data.tree.filter((t) => t.type === 'blob' && !PRIVATE.has(t.path) && !/^readme/i.test(t.path));
    for (let i = 0; i < files.length; i += 4) {
      await Promise.all(files.slice(i, i + 4).map(async (f) => {
        const blob = await gh('GET', `/repos/${repo}/git/blobs/${f.sha}`);
        if (blob.status !== 200) throw new Error(`download ${f.path} failed (${blob.status})`);
        const dest = path.join(dataDir, ...f.path.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, Buffer.from(blob.data.content, 'base64'));
        shas.set(f.path, f.sha);
      }));
    }
    log.log(`[store] pulled ${files.length} file(s) from ${repo}`);
  }

  // push one file (path relative to the data folder, with "/" separators)
  function save(rel) {
    if (!enabled || PRIVATE.has(rel)) return queue;
    return run(async () => {
      let buf;
      try { buf = await fsp.readFile(path.join(dataDir, ...rel.split('/'))); }
      catch (e) { if (e.code === 'ENOENT') return; throw e; } // deleted again before we got to it
      const body = { message: `update ${rel}`, content: buf.toString('base64'), ...onBranch() };
      if (shas.has(rel)) body.sha = shas.get(rel);
      let r = await gh('PUT', `/repos/${repo}/contents/${enc(rel)}`, body);
      if (r.status === 409 || r.status === 422) { // our sha was stale or missing
        body.sha = await currentSha(rel);
        r = await gh('PUT', `/repos/${repo}/contents/${enc(rel)}`, body);
      }
      if (r.status >= 300) throw new Error(`save ${rel} failed (${r.status} ${r.data.message || ''})`);
      shas.set(rel, r.data.content.sha);
    });
  }
  async function del(rel) {
    const sha = shas.get(rel) || (await currentSha(rel));
    if (!sha) return;
    let r = await gh('DELETE', `/repos/${repo}/contents/${enc(rel)}`, { message: `delete ${rel}`, sha, ...onBranch() });
    if (r.status === 409 || r.status === 422) {
      const fresh = await currentSha(rel);
      if (fresh) r = await gh('DELETE', `/repos/${repo}/contents/${enc(rel)}`, { message: `delete ${rel}`, sha: fresh, ...onBranch() });
    }
    if (r.status >= 300 && r.status !== 404) throw new Error(`delete ${rel} failed (${r.status} ${r.data.message || ''})`);
    shas.delete(rel);
  }
  const remove = (rel) => (enabled ? run(() => del(rel)) : queue);
  const removeDir = (dir) => (enabled ? run(async () => { for (const rel of [...shas.keys()].filter((k) => k.startsWith(dir + '/'))) await del(rel); }) : queue);
  // for files that change often (stats, logs): push at most once per `ms`
  function saveLater(rel, ms = 60000) {
    if (!enabled || timers.has(rel)) return;
    timers.set(rel, setTimeout(() => { timers.delete(rel); save(rel); }, ms));
  }
  const flush = () => { for (const [rel, t] of timers) { clearTimeout(t); timers.delete(rel); save(rel); } return queue; };

  return { enabled, pull, save, remove, removeDir, saveLater, flush };
}
