#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_dir="${ATHENA_PREPROD_STATE_DIR:-/data/athena-preproduction}"
secret_dir="${ATHENA_PREPROD_SECRETS_DIR:-${state_dir}/secrets}"
compose_files=(
  -f "${repo_root}/docker/docker-compose.modular.yml"
  -f "${repo_root}/docker/docker-compose.preproduction.yml"
)

test -f "${secret_dir}/runtime.env"
set -a
# shellcheck disable=SC1090
source "${secret_dir}/runtime.env"
set +a
export ATHENA_PREPROD_SECRETS_DIR="${secret_dir}"

docker compose \
  --env-file "${secret_dir}/runtime.env" \
  "${compose_files[@]}" \
  --profile "*" \
  ps

docker compose \
  --env-file "${secret_dir}/runtime.env" \
  "${compose_files[@]}" \
  --profile "*" \
  exec -T anything-llm-api \
  node scripts/verify-micro-module-preproduction.js \
  --timeout-ms 30000
