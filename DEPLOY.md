# Deploying Mimic Voice

The game is one Node server (`server.js`) that serves the site **and** the WebSocket for rooms/voice chat.
It needs a host that keeps a Node process running with WebSockets (Vercel/Netlify static hosting won't work).

## Option A – Render free plan (easiest)

No credit card needed. The free plan wipes its disk on every restart, so uploaded packs are kept in a
**private GitHub repo** instead (`store.js`): pulled when the server starts, and every upload/delete is pushed back.

1. **Code repo** – put the `mimic-voice` folder in its own GitHub repo (`.gitignore` keeps out `node_modules`, `data`, `tools`).
2. **Data repo** – create a second, **private** repo (e.g. `mimic-voice-data`) and push the contents of `data/`
   into it (packs.json, pack-stats.json, packs/…) – everything except `admin-key.txt`. An empty repo also works.
3. **Token** – GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
   *Only select repositories* → the data repo; *Repository permissions → Contents: Read and write*. No expiry (or a long one).
4. **Render** – render.com → **New → Blueprint** → pick the code repo. It asks for:
   `ADMIN_KEY` (any secret you like), `GITHUB_DATA_REPO` (`your-name/mimic-voice-data`), `GITHUB_TOKEN` (the token).
5. **Keep it awake** – the free plan sleeps after 15 min without traffic. Add a free monitor on
   uptimerobot.com (HTTP, every 5 min) pointing at `https://<your-app>.onrender.com/healthz`.

Limits on the free plan:
- A restart/redeploy ends running games (rooms live in memory); packs come back from the data repo.
- Every upload/delete in `/admin` becomes a commit in the data repo (that's the backup, too).
- Voice chat uses public STUN only; players behind strict networks may not hear each other (game still works).

## Option B – always-free VM (Oracle Cloud "Always Free")

A small VM that never sleeps and keeps uploaded packs on disk. The scripts in `deploy/oracle/` do the setup:
Node 20, a systemd service (`mimic-voice`), and Caddy in front for HTTPS (browsers only allow the microphone on HTTPS).

1. **Account** – sign up at cloud.oracle.com (Free Tier). Pick a home region close to your players
   (e.g. India West – Mumbai); it can't be changed later. A card is needed for verification only.
2. **SSH key** – the laptop key is `~/.ssh/mimic_oracle` (public part: `~/.ssh/mimic_oracle.pub`).
3. **VM** – Compute → Instances → Create instance:
   - Image: Canonical Ubuntu 24.04
   - Shape: `VM.Standard.E2.1.Micro` (Always Free), or `VM.Standard.A1.Flex` 1 OCPU / 6 GB if it has capacity
   - Networking: new VCN + public subnet, "Assign a public IPv4 address" on
   - SSH keys: paste the contents of `mimic_oracle.pub`
4. **Open the ports** – Networking → Virtual cloud networks → your VCN → Security → Default security list →
   Add ingress rules: source `0.0.0.0/0`, TCP, destination port `80`; and again for `443`.
5. **Domain** – on duckdns.org sign in, create a subdomain (e.g. `mimicvoice`) and set its IP to the VM's public IP.
6. **Setup** (from `mimic-voice/` in Git Bash):
   ```bash
   scp -i ~/.ssh/mimic_oracle deploy/oracle/setup.sh ubuntu@<ip>:/tmp/
   ssh -i ~/.ssh/mimic_oracle ubuntu@<ip> "sudo bash /tmp/setup.sh mimicvoice.duckdns.org"
   bash deploy/oracle/push.sh ubuntu@<ip> --with-data   # first time: also copies data/ (same admin key)
   ```
7. **Updates** later: `bash deploy/oracle/push.sh ubuntu@<ip>` (uploads code, keeps packs uploaded on the server).

Useful on the VM: `sudo systemctl status mimic-voice`, `sudo journalctl -u mimic-voice -f`, `sudo systemctl restart mimic-voice`.

Note: Oracle may reclaim an **idle** Always Free VM (very low CPU/network for 7 days). Upgrading the account to
Pay-As-You-Go stops that; resources inside the Always Free limits stay free.

## Environment variables

| Var | Default | What |
|---|---|---|
| `PORT` | 8793 | set automatically by most hosts |
| `ADMIN_KEY` | random, saved in `data/admin-key.txt` | key for `/admin` and `/lab` |
| `DATA_DIR` | `./data` | where uploaded packs, pack stats and reports are stored |
| `GITHUB_DATA_REPO` | – | `owner/repo` that mirrors the data folder (optional; for hosts without a disk) |
| `GITHUB_TOKEN` | – | fine-grained token with Contents read/write on that repo |
| `MV_ROUNDS` | 10 | default rounds per game (testing) |
