#!/usr/bin/env bash
# Upload the current game code to the Oracle VM and restart it (run from Git Bash on the laptop).
#   bash deploy/oracle/push.sh ubuntu@<ip>              – code only (server-side uploads are kept)
#   bash deploy/oracle/push.sh ubuntu@<ip> --with-data  – first time: also copy data/ (admin key, packs)
set -euo pipefail
HOST="${1:?usage: bash deploy/oracle/push.sh ubuntu@<ip> [--with-data]}"
KEY="${MV_SSH_KEY:-$HOME/.ssh/mimic_oracle}"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$KEY" -o StrictHostKeyChecking=accept-new)
cd "$(dirname "$0")/../.."

tar czf /tmp/mv-app.tgz server.js package.json package-lock.json public
"${SCP[@]}" /tmp/mv-app.tgz "$HOST:/tmp/mv-app.tgz"
if [ "${2:-}" = "--with-data" ]; then
  tar czf /tmp/mv-data.tgz -C data .
  "${SCP[@]}" /tmp/mv-data.tgz "$HOST:/tmp/mv-data.tgz"
fi

"${SSH[@]}" "$HOST" 'set -e
  sudo rm -rf /opt/mimic-voice/public
  sudo tar xzf /tmp/mv-app.tgz -C /opt/mimic-voice && rm /tmp/mv-app.tgz
  if [ -f /tmp/mv-data.tgz ]; then
    sudo tar xzf /tmp/mv-data.tgz -C /var/lib/mimic-voice && rm /tmp/mv-data.tgz
    sudo chown -R mimic:mimic /var/lib/mimic-voice
  fi
  cd /opt/mimic-voice && sudo npm ci --omit=dev --no-audit --no-fund --loglevel=error
  sudo systemctl restart mimic-voice
  sleep 2
  curl -fsS http://127.0.0.1:8793/healthz >/dev/null && echo "game is up"'
