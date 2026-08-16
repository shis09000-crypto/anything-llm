#!/usr/bin/env bash
set -euo pipefail

compose_file="${ATHENA_PROD_COMPOSE_FILE:-/data/anythingllm/compose/micro-modular/docker-compose.production-micro.json}"
env_file="${ATHENA_PROD_COMPOSE_ENV:-/data/anythingllm/micro-modular/secrets/compose.env}"
project="${ATHENA_PROD_COMPOSE_PROJECT:-athena-production-micro}"
service="${1:-}"
new_image="${2:-}"

case "$service" in
  anything-llm-edge-probe) image_variable=ATHENA_PROD_EDGE_PROBE_IMAGE ;;
  anything-llm-background-worker) image_variable=ATHENA_PROD_BACKGROUND_WORKER_IMAGE ;;
  anything-llm-realtime-gateway) image_variable=ATHENA_PROD_REALTIME_GATEWAY_IMAGE ;;
  anything-llm-reader-worker) image_variable=ATHENA_PROD_READER_WORKER_IMAGE ;;
  anything-llm-scheduler) image_variable=ATHENA_PROD_SCHEDULER_IMAGE ;;
  anything-llm-operations-plane) image_variable=ATHENA_PROD_OPERATIONS_PLANE_IMAGE ;;
  anything-llm-coordination-plane) image_variable=ATHENA_PROD_COORDINATION_PLANE_IMAGE ;;
  anything-llm-chat-runtime) image_variable=ATHENA_PROD_CHAT_RUNTIME_IMAGE ;;
  anything-llm-agent-runtime) image_variable=ATHENA_PROD_AGENT_RUNTIME_IMAGE ;;
  anything-llm-model-gateway) image_variable=ATHENA_PROD_MODEL_GATEWAY_IMAGE ;;
  anything-llm-responses-runtime) image_variable=ATHENA_PROD_RESPONSES_RUNTIME_IMAGE ;;
  anything-llm-character-performance-runtime) image_variable=ATHENA_PROD_CHARACTER_PERFORMANCE_RUNTIME_IMAGE ;;
  anything-llm-tool-broker) image_variable=ATHENA_PROD_TOOL_BROKER_IMAGE ;;
  anything-llm-crypto-market) image_variable=ATHENA_PROD_CRYPTO_MARKET_IMAGE ;;
  anything-llm-crypto-account) image_variable=ATHENA_PROD_CRYPTO_ACCOUNT_IMAGE ;;
  anything-llm-crypto-forecast) image_variable=ATHENA_PROD_CRYPTO_FORECAST_IMAGE ;;
  anything-llm-key-custody) image_variable=ATHENA_PROD_KEY_CUSTODY_IMAGE ;;
  anything-llm-identity) image_variable=ATHENA_PROD_IDENTITY_IMAGE ;;
  anything-llm-knowledge-ingest) image_variable=ATHENA_PROD_KNOWLEDGE_INGEST_IMAGE ;;
  anything-llm-rag) image_variable=ATHENA_PROD_RAG_IMAGE ;;
  anything-llm-operations-shadow-agents) image_variable=ATHENA_PROD_OPERATIONS_SHADOW_AGENTS_IMAGE ;;
  anything-llm-browser-plane) image_variable=ATHENA_PROD_BROWSER_PLANE_IMAGE ;;
  anything-llm-browser-worker) image_variable=ATHENA_PROD_BROWSER_WORKER_IMAGE ;;
  anything-llm-browser-egress) image_variable=ATHENA_PROD_BROWSER_EGRESS_IMAGE ;;
  anything-llm-collector) image_variable=ATHENA_PROD_COLLECTOR_IMAGE ;;
  *)
    echo "unsupported_module:$service" >&2
    echo "Use roll-api-blue-green.sh for API releases." >&2
    exit 2
    ;;
esac

if [[ ! "$new_image" =~ ^[a-zA-Z0-9._/:@-]+$ ]]; then
  echo "usage: $0 <service> <verified-image>" >&2
  exit 2
fi
if [[ ! -f "$compose_file" || ! -f "$env_file" ]]; then
  echo "production_compose_or_env_missing" >&2
  exit 2
fi
if [[ "$service" == "anything-llm-browser-worker" ]]; then
  browser_seccomp_profile="$(dirname "$compose_file")/playwright-seccomp-profile.json"
  if [[ ! -s "$browser_seccomp_profile" ]] ||
    ! jq empty "$browser_seccomp_profile" >/dev/null 2>&1; then
    echo "browser_worker_seccomp_policy_missing_or_invalid:$browser_seccomp_profile" >&2
    exit 2
  fi
fi
docker image inspect "$new_image" >/dev/null

compose=(docker compose --env-file "$env_file" -p "$project" -f "$compose_file")

wait_healthy() {
  local target_service="$1" container status
  for _ in $(seq 1 240); do
    container="$("${compose[@]}" ps -q "$target_service")"
    if [[ -n "$container" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
      if [[ "$status" == "healthy" || "$status" == "running" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "module_readiness_timeout:$target_service" >&2
  return 1
}

current_line="$(grep -E "^${image_variable}=" "$env_file" || true)"
if [[ -z "$current_line" ]]; then
  echo "module_image_setting_missing:$image_variable" >&2
  exit 2
fi
old_image="${current_line#*=}"
container="$("${compose[@]}" ps -q "$service")"
had_container=false
if [[ -n "$container" ]]; then
  had_container=true
  running_image="$(docker inspect -f '{{.Config.Image}}' "$container")"
  if [[ "$running_image" != "$old_image" ]]; then
    echo "module_image_state_mismatch:$service configured=$old_image running=$running_image" >&2
    exit 2
  fi
fi

backup="${env_file}.${service}.roll-backup"
cp -p "$env_file" "$backup"
rollout_complete=false

rollback() {
  local exit_code=$?
  if [[ "$rollout_complete" != "true" ]]; then
    cp -p "$backup" "$env_file"
    if [[ "$had_container" == "true" ]]; then
      "${compose[@]}" up -d --no-build --no-deps --force-recreate "$service" >/dev/null 2>&1 || true
      wait_healthy "$service" >/dev/null 2>&1 || true
    else
      "${compose[@]}" rm -sf "$service" >/dev/null 2>&1 || true
    fi
    echo "module_rollout=rolled_back service=$service image=$old_image" >&2
  fi
  rm -f "$backup"
  exit "$exit_code"
}
trap rollback ERR INT TERM

awk -v key="$image_variable" -v image="$new_image" '
  BEGIN { replaced = 0 }
  $0 ~ "^" key "=" { print key "=" image; replaced = 1; next }
  { print }
  END { if (!replaced) exit 2 }
' "$env_file" >"${env_file}.next"
chmod --reference="$env_file" "${env_file}.next"
mv "${env_file}.next" "$env_file"

"${compose[@]}" up -d --no-build --no-deps --force-recreate "$service"
wait_healthy "$service"

rollout_complete=true
rm -f "$backup"
trap - ERR INT TERM
echo "module_rollout=complete service=$service image=$new_image"
