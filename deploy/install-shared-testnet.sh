#!/usr/bin/env bash
# Installs or updates the shared NIR test network on a fresh Ubuntu server
# (docs/shared-testnet.md). Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/Buddhacoin/NIR/main/deploy/install-shared-testnet.sh \
#     | bash -s -- testnet.nircoin.com nircoin.com
#
# The optional second domain serves the website from site/ (and www. of it),
# with the network's read API under /api.
# Point the domain's DNS A record at this server first: the HTTPS certificate
# is issued for it automatically. Running the script again updates the code
# and restarts the node; the network and its keys are kept.
set -euo pipefail

DOMAIN="${1:-}"
SITE_DOMAIN="${2:-}"
NODE_VERSION="26.12.0"
REPO="https://github.com/Buddhacoin/NIR.git"
APP_DIR="/opt/nir"
DATA_DIR="/var/lib/nir"
NETWORK_DIR="$DATA_DIR/testnet"

if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "Usage: install-shared-testnet.sh <domain> [site-domain], for example testnet.nircoin.com nircoin.com" >&2; exit 1
fi
if [[ -n "$SITE_DOMAIN" && ! "$SITE_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "The site domain is invalid: $SITE_DOMAIN" >&2; exit 1
fi

echo "== System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates xz-utils libatomic1 ufw debian-keyring debian-archive-keyring apt-transport-https gnupg

echo "== Node.js $NODE_VERSION"
case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]]; then
  TMP="$(mktemp -d)"
  TARBALL="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSLo "$TMP/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  curl -fsSLo "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$TMP"
fi

echo "== Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== NIR code"
id nir >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin nir
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch -q origin main
  git -C "$APP_DIR" reset -q --hard origin/main
else
  git clone -q "$REPO" "$APP_DIR"
fi
install -d -o nir -g nir -m 0700 "$DATA_DIR"

echo "== Network"
if [[ ! -d "$NETWORK_DIR" ]]; then
  sudo -u nir /usr/local/bin/node "$APP_DIR/blockchain/shared-testnet-cli.mjs" init "$NETWORK_DIR" \
    | tee "$DATA_DIR/NETWORK.json"
fi

cat > /etc/systemd/system/nir-testnet.service <<EOF
[Unit]
Description=NIR shared test network
After=network-online.target
Wants=network-online.target

[Service]
User=nir
Group=nir
ExecStart=/usr/local/bin/node $APP_DIR/blockchain/shared-testnet-cli.mjs serve $NETWORK_DIR 8787 127.0.0.1 --behind-proxy
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
EOF
if [[ -n "$SITE_DOMAIN" ]]; then
  cat >> /etc/caddy/Caddyfile <<EOF

$SITE_DOMAIN, www.$SITE_DOMAIN {
  encode gzip
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  handle {
    root * $APP_DIR/site
    header /install.sh Content-Type "text/plain; charset=utf-8"
    header /install.ps1 Content-Type "text/plain; charset=utf-8"
    file_server
  }
}
EOF
fi

echo "== Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable --now nir-testnet.service
systemctl restart nir-testnet.service
systemctl reload caddy || systemctl restart caddy

echo
echo "== Done"
cat "$DATA_DIR/NETWORK.json"
echo "Check: https://$DOMAIN/health (the certificate may take a minute after DNS points here)"
if [[ -n "$SITE_DOMAIN" ]]; then echo "Website: https://$SITE_DOMAIN"; fi
