#!/usr/bin/env bash
# One-time setup of an Oracle Cloud "Always Free" Ubuntu VM for Mimic Voice:
# Node 20 + a systemd service for the game + Caddy for HTTPS (browsers only allow the mic on HTTPS).
# Run on the VM:  sudo bash setup.sh your-name.duckdns.org
set -euo pipefail
DOMAIN="${1:?usage: sudo bash setup.sh <domain>}"
APP=/opt/mimic-voice
DATA=/var/lib/mimic-voice
export DEBIAN_FRONTEND=noninteractive

echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get update
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

# Node 20
if ! command -v node >/dev/null || ! node -v | grep -qE '^v(2[0-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic Let's Encrypt certificates, passes websockets through)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# the game runs as its own unprivileged user; uploads/stats/admin key live in $DATA
id mimic >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin mimic
mkdir -p "$APP" "$DATA"
chown -R mimic:mimic "$DATA"

cat > /etc/systemd/system/mimic-voice.service <<EOF
[Unit]
Description=Mimic Voice game server
After=network-online.target
Wants=network-online.target

[Service]
User=mimic
WorkingDirectory=$APP
Environment=NODE_ENV=production PORT=8793 DATA_DIR=$DATA
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8793
}
EOF

# Oracle's Ubuntu image rejects everything except SSH: allow 80/443 above its REJECT rule
for p in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
    n=$(iptables -L INPUT --line-numbers | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$n" ]; then iptables -I INPUT "$n" -p tcp -m state --state NEW --dport "$p" -j ACCEPT
    else iptables -A INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT; fi
  fi
done
netfilter-persistent save

systemctl daemon-reload
systemctl enable mimic-voice caddy
systemctl restart caddy
echo "setup done for https://$DOMAIN – now push the game from your laptop (deploy/oracle/push.sh)"
