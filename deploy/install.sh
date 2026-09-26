#!/usr/bin/env bash
# =============================================================================
#  Install the pricing system on a fresh Ubuntu 22.04 / 24.04 server (Hostinger VPS)
#
#    curl -fsSL https://raw.githubusercontent.com/mohdhadhrami/Aluminum/HEAD/deploy/install.sh -o install.sh
#    sudo bash install.sh calc.radma.co you@example.com
#
#  Before running: point the subdomain's DNS "A" record at this server's IP.
#  Safe to run again: it updates the code and keeps the database and password.
# =============================================================================
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash install.sh <subdomain e.g. calc.radma.co> <email for the HTTPS certificate>}"
EMAIL="${2:?Usage: sudo bash install.sh <subdomain> <email>}"
REPO_URL="${REPO_URL:-https://github.com/mohdhadhrami/Aluminum.git}"
APP_DIR=/opt/radma-calc
DATA_DIR=/var/lib/radma-calc
APP_USER=radmacalc
PORT=3000

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash install.sh ..."; exit 1; }
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx sqlite3 ufw ca-certificates

if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    say "Installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

say "Getting the code"
if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
else
    if ! git clone "$REPO_URL" "$APP_DIR"; then
        echo "Could not clone $REPO_URL."
        echo "If the repository is private, run again with a read token:"
        echo "  REPO_URL=https://<TOKEN>@github.com/mohdhadhrami/Aluminum.git sudo -E bash install.sh $DOMAIN $EMAIL"
        exit 1
    fi
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

say "Configuration"
mkdir -p "$DATA_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
if [ ! -f "$APP_DIR/.env" ]; then
    ADMIN_TOKEN="$(openssl rand -hex 12)"
    cat > "$APP_DIR/.env" <<ENV
PORT=$PORT
ADMIN_TOKEN=$ADMIN_TOKEN
TRUST_PROXY=1
DB_FILE=$DATA_DIR/aluminum.db
EMBED_ALLOWED_ORIGINS=https://radma.co https://www.radma.co
ENV
fi
chown root:"$APP_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"

# Public link used in PDFs and WhatsApp messages
DB_PATH="$(grep '^DB_FILE=' "$APP_DIR/.env" | cut -d= -f2-)"
sudo -u "$APP_USER" DB_FILE="${DB_PATH:-$DATA_DIR/aluminum.db}" SEED_SAMPLE=1 node --disable-warning=ExperimentalWarning -e "
    const { openDatabase, saveSettings } = require('./src/db');
    saveSettings(openDatabase(), { public_base_url: 'https://$DOMAIN' });"

say "Service (starts on boot, restarts if it stops)"
cat > /etc/systemd/system/radma-calc.service <<UNIT
[Unit]
Description=Radma rolling-shutter pricing system
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable radma-calc >/dev/null
systemctl restart radma-calc

say "Web server (Nginx) for $DOMAIN"
cat > /etc/nginx/sites-available/radma-calc <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/radma-calc /etc/nginx/sites-enabled/radma-calc
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

say "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

say "HTTPS certificate (Let's Encrypt)"
if ! certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect -n; then
    echo "!! The certificate failed. Usually the DNS A record for $DOMAIN does not point to this server yet."
    echo "   After fixing DNS, run:  sudo certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect -n"
fi

say "Daily database backup (kept 14 days)"
cat > /etc/cron.daily/radma-calc-backup <<CRON
#!/bin/sh
sqlite3 $DATA_DIR/aluminum.db ".backup '$DATA_DIR/backups/aluminum-\$(date +%F).db'"
find $DATA_DIR/backups -name 'aluminum-*.db' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/radma-calc-backup

sleep 2
systemctl is-active --quiet radma-calc && STATUS="running" || STATUS="NOT running — see: journalctl -u radma-calc -n 50"
TOKEN="$(grep '^ADMIN_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-)"
cat <<DONE

==========================================================
  Done. Service: $STATUS

  Customer calculator (share this link):  https://$DOMAIN
  Admin panel:                            https://$DOMAIN/admin
  Admin password:                         $TOKEN
    (stored in $APP_DIR/.env — change ADMIN_TOKEN there, then: sudo systemctl restart radma-calc)

  Embed on radma.co:
    <div data-radma-calculator></div>
    <script src="https://$DOMAIN/embed.js" async></script>

  Update to the latest version later:  sudo bash $APP_DIR/deploy/update.sh
==========================================================
DONE
