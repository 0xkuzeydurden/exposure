#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for EXPOSURE (run as root over SSH):
#   ssh root@SERVER 'bash -s' < scripts/server-setup.sh
# Installs Docker from Docker's apt repository, closes everything but SSH/HTTP/HTTPS, turns off SSH
# passwords, enables automatic security updates and fail2ban, adds swap for the build, and clones
# the app to /opt/exposure. Secrets are added separately (see docs/deploy.md).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
REPO_URL="${REPO_URL:-https://github.com/0xkuzeydurden/exposure.git}"
APP_DIR="${APP_DIR:-/opt/exposure}"

apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw fail2ban unattended-upgrades

# Docker Engine + compose plugin from Docker's own repository.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Firewall: SSH, HTTP, HTTPS only. The app port (3000) is never published outside Docker.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# SSH: keys only.
cat > /etc/ssh/sshd_config.d/10-exposure.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh

systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

# 2 GB swap so `next build` never runs out of memory on a small instance.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# App checkout + persistent data owned by the container's non-root "node" user (uid 1000).
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data/cache" "$APP_DIR/data/ledger"
chown -R 1000:1000 "$APP_DIR/data"

echo "setup done: add $APP_DIR/.env.production (chmod 600), then: cd $APP_DIR && docker compose up -d --build"
