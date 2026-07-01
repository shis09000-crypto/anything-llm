#!/usr/bin/env bash
set -euo pipefail

HOST="${TENCENT_CLOUD_HOST:-43.133.177.153}"
USER="${TENCENT_CLOUD_USER:-deploy}"
CONTAINER="${TENCENT_CLOUD_APP_CONTAINER:-anythingllm-v2}"
KEY_CANDIDATES=(
  "${TENCENT_CLOUD_KEY:-}"
  "$HOME/.ssh/anythingllm-tencent-deploy-stage21-ed25519"
  "$HOME/.ssh/anythingllm-tencent-ed25519"
)

SINCE="10m"
TAIL="200"
FOLLOW=false
TARGET="app"
GREP_PATTERN=""

usage() {
  cat <<'EOF'
Usage: bash scripts/tencent-cloud-logs.sh [--app|--caddy|--mobile-client] [--since 10m] [--tail 200] [--follow] [--grep pattern]

Read-only Tencent Cloud log helper.
Targets:
  --app            docker logs anythingllm-v2 (default)
  --caddy          docker logs asg-caddy-web and asg-caddy-l4
  --mobile-client  tail /data/anythingllm/storage/logs/mobile-client-debug.log

Environment overrides:
  TENCENT_CLOUD_HOST, TENCENT_CLOUD_USER, TENCENT_CLOUD_KEY, TENCENT_CLOUD_APP_CONTAINER
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) TARGET="app"; shift ;;
    --caddy) TARGET="caddy"; shift ;;
    --mobile-client) TARGET="mobile-client"; shift ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    --tail) TAIL="${2:-}"; shift 2 ;;
    --follow|-f) FOLLOW=true; shift ;;
    --grep) GREP_PATTERN="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

choose_key() {
  for key in "${KEY_CANDIDATES[@]}"; do
    [[ -n "$key" && -f "$key" ]] || continue
    if ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=6 "$USER@$HOST" "true" >/dev/null 2>&1; then
      printf '%s' "$key"
      return 0
    fi
  done
  return 1
}

KEY="$(choose_key)" || {
  echo "No usable SSH key found for ${USER}@${HOST}." >&2
  echo "Set TENCENT_CLOUD_KEY=/path/to/key or restore deploy access." >&2
  exit 1
}

remote_command() {
  case "$TARGET" in
    app)
      if [[ "$FOLLOW" == true ]]; then
        printf "sudo -n docker logs --since=%q --tail=%q -f %q 2>&1" "$SINCE" "$TAIL" "$CONTAINER"
      else
        printf "sudo -n docker logs --since=%q --tail=%q %q 2>&1" "$SINCE" "$TAIL" "$CONTAINER"
      fi
      ;;
    caddy)
      if [[ "$FOLLOW" == true ]]; then
        printf "echo '== asg-caddy-web =='; sudo -n docker logs --since=%q --tail=%q -f asg-caddy-web 2>&1; echo '== asg-caddy-l4 =='; sudo -n docker logs --since=%q --tail=%q -f asg-caddy-l4 2>&1" "$SINCE" "$TAIL" "$SINCE" "$TAIL"
      else
        printf "echo '== asg-caddy-web =='; sudo -n docker logs --since=%q --tail=%q asg-caddy-web 2>&1; echo '== asg-caddy-l4 =='; sudo -n docker logs --since=%q --tail=%q asg-caddy-l4 2>&1" "$SINCE" "$TAIL" "$SINCE" "$TAIL"
      fi
      ;;
    mobile-client)
      if [[ "$FOLLOW" == true ]]; then
        printf "if test -f /data/anythingllm/storage/logs/mobile-client-debug.log; then tail -n %q -f /data/anythingllm/storage/logs/mobile-client-debug.log; else echo 'mobile-client-debug.log not found'; fi" "$TAIL"
      else
        printf "if test -f /data/anythingllm/storage/logs/mobile-client-debug.log; then tail -n %q /data/anythingllm/storage/logs/mobile-client-debug.log; else echo 'mobile-client-debug.log not found'; fi" "$TAIL"
      fi
      ;;
  esac
}

redact() {
  sed -E \
    -e 's/(Authorization: Bearer )[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/Ig' \
    -e 's/(authorization[":= ]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/Ig' \
    -e 's/(cookie[":= ]+)[^" ]+/\1[REDACTED]/Ig' \
    -e 's/(token|password|secret|jwt)(["=: ]+)[^", ]+/\1\2[REDACTED]/Ig'
}

CMD="$(remote_command)"
if [[ -n "$GREP_PATTERN" ]]; then
  { ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no "$USER@$HOST" "$CMD" | grep -E "$GREP_PATTERN" || true; } | redact
else
  ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no "$USER@$HOST" "$CMD" | redact
fi
