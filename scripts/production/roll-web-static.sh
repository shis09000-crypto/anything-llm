#!/usr/bin/env bash
set -euo pipefail

compose_file="${ATHENA_PROD_COMPOSE_FILE:-/data/anythingllm/compose/micro-modular/docker-compose.production-micro.json}"
env_file="${ATHENA_PROD_COMPOSE_ENV:-/data/anythingllm/micro-modular/secrets/compose.env}"
project="${ATHENA_PROD_COMPOSE_PROJECT:-athena-production-micro}"
public_origin="${ATHENA_PROD_PUBLIC_ORIGIN:-https://athenallm.online}"
public_health_url="${ATHENA_PROD_PUBLIC_HEALTH_URL:-${public_origin%/}/health}"
public_login_url="${ATHENA_PROD_PUBLIC_LOGIN_URL:-${public_origin%/}/login?nt=1}"
candidate_root="${1:-}"

if [[ ! -d "$candidate_root" || ! -f "$candidate_root/index.html" ]]; then
  echo "verified_web_root_required" >&2
  exit 2
fi

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

mapfile -t entry_assets < <(
  grep -oE '/assets/[^"[:space:]]+' "$candidate_root/index.html" | sort -u
)
if [[ "${#entry_assets[@]}" -eq 0 ]]; then
  echo "candidate_entry_assets_missing" >&2
  exit 1
fi
for asset in "${entry_assets[@]}"; do
  if [[ ! -r "$candidate_root/${asset#/}" ]]; then
    echo "candidate_web_asset_missing:$asset" >&2
    exit 1
  fi
done

required_runtime_assets=("crypto-icons/btc.png")
for asset in "${required_runtime_assets[@]}"; do
  if [[ ! -r "$candidate_root/$asset" ]]; then
    echo "candidate_runtime_asset_missing_or_unreadable:$asset" >&2
    exit 1
  fi
done

compose=(docker compose --env-file "$env_file" -p "$project" -f "$compose_file")
backup_root="${web_root}.roll-backup-$(date -u +%Y%m%dT%H%M%SZ)"
probe_root="$(mktemp -d)"
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

verify_public_release() {
  local asset candidate_sha public_sha public_file
  curl --silent --show-error --fail --max-time 15 \
    --header 'Cache-Control: no-cache' "$public_health_url" \
    >"$probe_root/health.json"
  curl --silent --show-error --fail --max-time 15 \
    --header 'Cache-Control: no-cache' "$public_login_url" \
    >"$probe_root/login.html"
  if ! grep -qi '<!doctype html' "$probe_root/login.html"; then
    echo "public_login_page_invalid" >&2
    return 1
  fi

  for asset in "${entry_assets[@]}"; do
    public_file="$probe_root/$(basename "$asset")"
    curl --silent --show-error --fail --max-time 30 \
      --header 'Cache-Control: no-cache' "${public_origin%/}$asset" \
      >"$public_file"
    # The candidate is atomically moved into the configured web root before
    # public verification. Hash the deployed copy so the probe remains valid
    # after that move and also verifies the exact files nginx is serving.
    candidate_sha="$(sha256sum "$web_root/${asset#/}" | awk '{print $1}')"
    public_sha="$(sha256sum "$public_file" | awk '{print $1}')"
    if [[ "$candidate_sha" != "$public_sha" ]]; then
      echo "public_asset_hash_mismatch:$asset" >&2
      return 1
    fi
  done

  for asset in "${required_runtime_assets[@]}"; do
    curl --silent --show-error --fail --max-time 15 \
      --header 'Cache-Control: no-cache' "${public_origin%/}/$asset" \
      >/dev/null
  done
}

rollback() {
  local exit_code=$?
  rm -rf -- "$probe_root"
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
verify_public_release

rollout_complete=true
trap - ERR INT TERM
rm -rf -- "$probe_root"
echo "web_static_rollout=complete backup_root=$backup_root"
