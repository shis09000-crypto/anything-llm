#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/.dev-ssl"
PUBLIC_CA="$ROOT_DIR/frontend/public/athena-mobile-dev-ca.crt"
CA_KEY="$CERT_DIR/athena-mobile-dev-ca.key"
CA_CERT="$CERT_DIR/athena-mobile-dev-ca.crt"
SERVER_KEY="$CERT_DIR/athena-mobile-dev.key"
SERVER_CSR="$CERT_DIR/athena-mobile-dev.csr"
SERVER_CERT="$CERT_DIR/athena-mobile-dev.crt"
OPENSSL_CONF="$CERT_DIR/athena-mobile-dev.openssl.cnf"
LOCAL_NAME="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
LOCAL_HOST="${LOCAL_NAME}.local"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
SERVER_PORT="${SERVER_PORT:-3002}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

stop_pid_tree() {
  local pid="${1:-}"
  local child

  if ! pid_alive "$pid"; then return 0; fi
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    stop_pid_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

stop_existing_development_supervisor() {
  local pid

  for pid in $(pgrep -f "$ROOT_DIR/scripts/runtime-supervisor.sh --env development" 2>/dev/null || true); do
    stop_pid_tree "$pid"
  done
}

stop_existing_frontend_listener() {
  local pid
  local cwd
  local cmd

  for pid in $(lsof -tiTCP:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cwd" == "$ROOT_DIR"* && "$cmd" == *"vite"* ]]; then
      stop_pid_tree "$pid"
    fi
  done
}

if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

if [[ -z "$LAN_IP" ]]; then
  echo "Could not detect a LAN IP address. Connect to Wi-Fi and retry." >&2
  exit 1
fi

mkdir -p "$CERT_DIR" "$(dirname "$PUBLIC_CA")"

if [[ ! -f "$CA_KEY" || ! -f "$CA_CERT" ]]; then
  openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
  openssl req \
    -x509 \
    -new \
    -nodes \
    -key "$CA_KEY" \
    -sha256 \
    -days 3650 \
    -subj "/CN=Athena Mobile Dev CA" \
    -out "$CA_CERT" >/dev/null 2>&1
fi

cat >"$OPENSSL_CONF" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req

[dn]
CN = ${LOCAL_HOST}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = ${LOCAL_HOST}
IP.1 = 127.0.0.1
IP.2 = ${LAN_IP}
EOF

openssl genrsa -out "$SERVER_KEY" 2048 >/dev/null 2>&1
openssl req \
  -new \
  -key "$SERVER_KEY" \
  -out "$SERVER_CSR" \
  -config "$OPENSSL_CONF" >/dev/null 2>&1
openssl x509 \
  -req \
  -in "$SERVER_CSR" \
  -CA "$CA_CERT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$SERVER_CERT" \
  -days 825 \
  -sha256 \
  -extensions v3_req \
  -extfile "$OPENSSL_CONF" >/dev/null 2>&1

cp "$CA_CERT" "$PUBLIC_CA"

cat <<EOF
Athena mobile HTTPS dev is starting.

Phone URL:
  https://${LOCAL_HOST}:${FRONTEND_PORT}
  https://${LAN_IP}:${FRONTEND_PORT}

API proxy target:
  http://127.0.0.1:${SERVER_PORT}

If iPhone/iPad reports the certificate is not trusted:
  1. Send this file to the device: ${CA_CERT}
  2. Install the profile.
  3. Enable full trust in Settings > General > About > Certificate Trust Settings.

Passkeys and zero-knowledge quick login only work after the phone trusts this HTTPS origin.
EOF

stop_existing_development_supervisor
stop_existing_frontend_listener

cd "$ROOT_DIR"
MOBILE_HTTPS=true \
VITE_DEV_HTTPS=true \
VITE_HTTPS_KEY_PATH="$SERVER_KEY" \
VITE_HTTPS_CERT_PATH="$SERVER_CERT" \
MOBILE_HTTPS_API_BASE="/api" \
PUBLIC_DEV_HOST="$LOCAL_HOST" \
SERVER_PORT="$SERVER_PORT" \
FRONTEND_PORT="$FRONTEND_PORT" \
bash "$ROOT_DIR/scripts/runtime-supervisor.sh" --env development
