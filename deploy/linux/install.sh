#!/usr/bin/env bash
# Installs pos-api under PM2 on Linux (counter PC in the LAN profile, or a VPS in
# the cloud profile): a dedicated service account, a data folder only that
# account can read, an env file, PM2 start-on-boot, and the firewall rule.
#
#   sudo deploy/linux/install.sh /path/to/pos-api.env
#
# The env file holds the settings from .env.example (DEPLOY_PROFILE, HOST, PORT,
# DATA_DIR, WORKBOOK_SHEET_PASSWORD, TLS_*, CORS_ORIGIN, OFFSITE_BACKUP_DIR...).
# Run from the repository root after `npm ci && npm run build`.
set -euo pipefail

SRC_ENV="${1:?usage: install.sh <env-file>}"
SERVICE_USER="${SERVICE_USER:-dhabapos}"
ETC_DIR=/etc/dhaba-pos
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -f "$APP_DIR/apps/pos-api/dist/main.js" ] || { echo "build first: npm ci && npm run build"; exit 1; }
command -v pm2 >/dev/null || npm install -g pm2

# 1. Service account with no login shell.
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"

# 2. Env file readable only by root and the service account.
install -d -m 750 -o root -g "$SERVICE_USER" "$ETC_DIR"
install -m 640 -o root -g "$SERVICE_USER" "$SRC_ENV" "$ETC_DIR/pos-api.env"
set -a; . "$ETC_DIR/pos-api.env"; set +a

# 3. Data folder: owner only (pos-api also enforces mode 700 on every start).
DATA_DIR="${DATA_DIR:?DATA_DIR must be set in the env file}"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
chmod -R go-rwx "$DATA_DIR"

# 4. Ports below 1024 (80/443) without running as root.
if [ "${PORT:-3000}" -lt 1024 ] || [ "${HTTP_REDIRECT_PORT:-1024}" -lt 1024 ]; then
  setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"
fi
# Let's Encrypt keys are root-only; give the service account read access.
if [ -n "${TLS_KEY_FILE:-}" ] && [[ "$TLS_KEY_FILE" == /etc/letsencrypt/* ]]; then
  setfacl -R -m "u:$SERVICE_USER:rX" /etc/letsencrypt/live /etc/letsencrypt/archive
fi

# 5. Review the configuration before starting (fails on e.g. a cloud profile without an off-server copy).
sudo -H -u "$SERVICE_USER" bash -c "set -a; . '$ETC_DIR/pos-api.env'; set +a; exec node '$APP_DIR/apps/pos-api/dist/deploy-check.js'"

# 6. PM2 under the service account, started on boot.
sudo -H -u "$SERVICE_USER" POS_ENV_FILE="$ETC_DIR/pos-api.env" pm2 startOrReload "$APP_DIR/deploy/linux/ecosystem.config.js"
sudo -H -u "$SERVICE_USER" pm2 save
pm2 startup systemd -u "$SERVICE_USER" --hp "$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

# 7. Firewall (ufw, if present).
if command -v ufw >/dev/null; then
  if [ "${DEPLOY_PROFILE:-lan}" = cloud ]; then
    ufw allow "${PORT:-443}/tcp"
    [ -n "${HTTP_REDIRECT_PORT:-}" ] && ufw allow "${HTTP_REDIRECT_PORT}/tcp"
  else
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do ufw allow from "$net" to any port "${PORT:-3000}" proto tcp; done
  fi
fi

echo "pos-api installed under PM2 as $SERVICE_USER; it starts on boot. Logs: sudo -u $SERVICE_USER pm2 logs pos-api"
