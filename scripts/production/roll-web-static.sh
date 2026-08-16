#!/usr/bin/env bash
set -euo pipefail

compose_file="${ATHENA_PROD_COMPOSE_FILE:-/data/anythingllm/compose/micro-modular/docker-compose.production-micro.json}"
env_file="${ATHENA_PROD_COMPOSE_ENV:-/data/anythingllm/micro-modular/secrets/compose.env}"
project="${ATHENA_PROD_COMPOSE_PROJECT:-athena-production-micro}"
public_probe="${ATHENA_PROD_PUBLIC_URL:-https://athenallm.online/}"
candidate_root="${1:-}"

if [[ ! -d "$candidate_root" || ! -f "$candidate_root/index.html" ]]; then
  echo "verified_web_root_required" >&2
  exit 2
fi

# Build artifacts created on macOS can inherit owner-only source modes. The
# published tree is mounted read-only by an unprivileged Nginx worker, so
# normalize the candidate before validation and the atomic directory swap.
find "$candidate_root" -type d -exec chmod 0755 {} +
find "$candidate_root" -type f -exec chmod 0644 {} +

if [[ ! -f "$compose_file" || ! -f "$env_file" ]]; then
  echo "production_compose_or_env_missing" >&2
  exit 2
fi

web_root_line="$(grep -E '^ATHENA_PROD_WEB_ROOT=' "$env_file" || true)"
if [[ -z "$web_root_line" ]]; then
  echo "production_web_root_missing" >&2
  exit 2
fi
web_root="${web_root_line#ATHENA_PROD_WEB_ROOT=}"
if [[ ! -d "$web_root" || "$candidate_root" == "$web_root" ]]; then
  echo "production_web_root_invalid" >&2
  exit 2
fi

while IFS= read -r asset; do
  [[ -z "$asset" ]] && continue
  if [[ ! -f "$candidate_root/${asset#/}" ]]; then
    echo "candidate_web_asset_missing:$asset" >&2
    exit 1
  fi
done < <(grep -oE '/assets/[^"[:space:]]+' "$candidate_root/index.html" | sort -u)

# Crypto Center icons are runtime URLs and therefore are not referenced by the
# Vite entrypoint. Treat the canonical icon as a release invariant so a static
# copy with owner-only modes cannot pass readiness while the private dashboard
# renders broken assets.
required_runtime_assets=(
  "crypto-icons/btc.png"
)
for asset in "${required_runtime_assets[@]}"; do
  if [[ ! -r "$candidate_root/$asset" ]]; then
    echo "candidate_runtime_asset_missing_or_unreadable:$asset" >&2
    exit 1
  fi
done

compose=(docker compose --env-file "$env_file" -p "$project" -f "$compose_file")
backup_root="${web_root}.roll-backup-$(date -u +%Y%m%dT%H%M%SZ)"
rollout_complete=false

wait_healthy() {
  local container status
  for _ in $(seq 1 120); do
    container="$("${compose[@]}" ps -q anything-llm-web)"
    if [[ -n "$container" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "web_readiness_timeout" >&2
  return 1
}

rollback() {
  local exit_code=$?
  if [[ "$rollout_complete" != "true" ]]; then
    failed_root="${candidate_root}.failed-$(date -u +%Y%m%dT%H%M%SZ)"
    if [[ -d "$web_root" ]]; then mv "$web_root" "$failed_root"; fi
    if [[ -d "$backup_root" ]]; then mv "$backup_root" "$web_root"; fi
    "${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-web >/dev/null 2>&1 || true
    wait_healthy >/dev/null 2>&1 || true
    echo "web_static_rollout=rolled_back failed_root=$failed_root" >&2
  fi
  exit "$exit_code"
}
trap rollback ERR INT TERM

mv "$web_root" "$backup_root"
mv "$candidate_root" "$web_root"
"${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-web
wait_healthy
curl --silent --show-error --fail --max-time 15 "$public_probe" >/dev/null
for asset in "${required_runtime_assets[@]}"; do
  asset_url="${public_probe%/}/$asset"
  curl --silent --show-error --fail --max-time 15 "$asset_url" >/dev/null
done

rollout_complete=true
trap - ERR INT TERM
echo "web_static_rollout=complete backup_root=$backup_root"
