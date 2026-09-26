#!/usr/bin/env bash
# Update the server to the latest code on GitHub (database and password are kept).
#   sudo bash /opt/radma-calc/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/radma-calc
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
cd "$APP_DIR"
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund
systemctl restart radma-calc
sleep 2
systemctl is-active --quiet radma-calc && echo "Updated and running." || { echo "Service failed to start:"; journalctl -u radma-calc -n 30 --no-pager; exit 1; }
