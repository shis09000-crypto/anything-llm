#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD_URL="${ATHENA_CLOUD_MOBILE_URL:-https://athenallm.online}"
DEV_KEY_PATH="${VITE_HTTPS_KEY_PATH:-$ROOT_DIR/.dev-ssl/athena-dev.key}"
DEV_CERT_PATH="${VITE_HTTPS_CERT_PATH:-$ROOT_DIR/.dev-ssl/athena-dev.crt}"
DEV_PROTOCOL="http"
VITE_HTTPS_VALUE="false"

if [[ -f "$DEV_KEY_PATH" && -f "$DEV_CERT_PATH" ]]; then
  DEV_PROTOCOL="https"
  VITE_HTTPS_VALUE="true"
fi

cat <<EOF
[mobile-cloud-dev] Starting local frontend against cloud API.
[mobile-cloud-dev] Cloud API target: ${CLOUD_URL}
[mobile-cloud-dev] Local protocol: ${DEV_PROTOCOL}
[mobile-cloud-dev] Open:
  ${DEV_PROTOCOL}://localhost:3000/settings/mobile-page-experiment
  ${DEV_PROTOCOL}://localhost:3000/settings/mobile-page-experiment?cloudMobile=proxy&real=1&athenaMobile=1&athenaPlatform=ios
  ${DEV_PROTOCOL}://localhost:3000/settings/mobile-page-experiment?cloudMobile=launch
  ${DEV_PROTOCOL}://localhost:3000/settings/mobile-page-experiment?cloudMobile=mock
EOF

cd "$ROOT_DIR/frontend"
VITE_DEV_API_PROXY_TARGET="$CLOUD_URL" \
VITE_DEV_API_PROXY_CHANGE_ORIGIN=true \
VITE_DEV_HTTPS="$VITE_HTTPS_VALUE" \
VITE_HTTPS_KEY_PATH="$DEV_KEY_PATH" \
VITE_HTTPS_CERT_PATH="$DEV_CERT_PATH" \
DEBUG= \
NODE_ENV=development \
./node_modules/.bin/vite --host=0.0.0.0
