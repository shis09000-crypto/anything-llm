#!/usr/bin/env bash
set -euo pipefail

compose_file="${ATHENA_PROD_COMPOSE_FILE:-/data/anythingllm/compose/micro-modular/docker-compose.production-micro.json}"
env_file="${ATHENA_PROD_COMPOSE_ENV:-/data/anythingllm/micro-modular/secrets/compose.env}"
project="${ATHENA_PROD_COMPOSE_PROJECT:-athena-production-micro}"
public_probe="${ATHENA_PROD_PUBLIC_READY_URL:-https://athenallm.online/api/ready}"
new_image="${1:-}"

if [[ ! "$new_image" =~ ^[a-zA-Z0-9._/:@-]+$ ]]; then
  echo "usage: $0 <verified-backend-image>" >&2
  exit 2
fi
if [[ ! -f "$compose_file" || ! -f "$env_file" ]]; then
  echo "production_compose_or_env_missing" >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null

compose=(docker compose --env-file "$env_file" -p "$project" -f "$compose_file")

wait_healthy() {
  local service="$1"
  local container status
  for _ in $(seq 1 180); do
    container="$("${compose[@]}" ps -q "$service")"
    if [[ -n "$container" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "api_slot_readiness_timeout:$service" >&2
  return 1
}

current_line="$(grep -E '^ATHENA_PROD_BACKEND_IMAGE=' "$env_file" || true)"
if [[ -z "$current_line" ]]; then
  echo "backend_image_setting_missing" >&2
  exit 2
fi
old_image="${current_line#ATHENA_PROD_BACKEND_IMAGE=}"
backup="${env_file}.api-roll-backup"
cp -p "$env_file" "$backup"
rollout_complete=false
proxy_switched=false

rollback() {
  local exit_code=$?
  if [[ "$rollout_complete" != "true" ]]; then
    cp -p "$backup" "$env_file"
    if [[ "$proxy_switched" != "true" ]]; then
      # The public proxy still points at the untouched blue slot. Removing the
      # failed candidate is sufficient; recreating blue here would turn an
      # isolated candidate failure into a public outage.
      "${compose[@]}" rm -sf anything-llm-api-green >/dev/null 2>&1 || true
    else
      # Green is still serving candidate traffic. Restore blue first while
      # green remains available, then restore green while blue serves.
      "${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api >/dev/null 2>&1 || true
      wait_healthy anything-llm-api >/dev/null 2>&1 || true
      "${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api-tls >/dev/null 2>&1 || true
      "${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api-green >/dev/null 2>&1 || true
      wait_healthy anything-llm-api-green >/dev/null 2>&1 || true
      "${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api-tls >/dev/null 2>&1 || true
    fi
    curl --silent --show-error --fail --max-time 10 "$public_probe" >/dev/null 2>&1 || true
    echo "api_blue_green_rollout=rolled_back image=$old_image" >&2
  fi
  rm -f "$backup"
  exit "$exit_code"
}
trap rollback ERR INT TERM

awk -v image="$new_image" '
  BEGIN { replaced = 0 }
  /^ATHENA_PROD_BACKEND_IMAGE=/ { print "ATHENA_PROD_BACKEND_IMAGE=" image; replaced = 1; next }
  { print }
  END { if (!replaced) exit 2 }
' "$env_file" >"${env_file}.next"
chmod --reference="$env_file" "${env_file}.next"
mv "${env_file}.next" "$env_file"

# Bring up the inactive slot while the currently active blue slot still owns
# all public traffic. Only after green is healthy do we reload the stable mTLS
# proxy with the two-slot upstream. That ordering is what removes the previous
# 16-21 second API restart window during the first cutover as well as later
# releases.
"${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api-green
wait_healthy anything-llm-api-green
"${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api-tls
curl --silent --show-error --fail --retry 12 --retry-delay 1 \
  --retry-all-errors --max-time 10 "$public_probe" >/dev/null
proxy_switched=true

"${compose[@]}" up -d --no-build --no-deps --force-recreate anything-llm-api
wait_healthy anything-llm-api
curl --silent --show-error --fail --max-time 10 "$public_probe" >/dev/null

for _ in $(seq 1 5); do
  curl --silent --show-error --fail --max-time 10 "$public_probe" >/dev/null
  sleep 1
done

rollout_complete=true
rm -f "$backup"
trap - ERR INT TERM
echo "api_blue_green_rollout=complete image=$new_image"
