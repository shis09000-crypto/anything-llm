#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_dir="${ATHENA_PREPROD_STATE_DIR:-/data/athena-preproduction}"
secret_dir="${ATHENA_PREPROD_SECRETS_DIR:-${state_dir}/secrets}"
evidence_dir="${ATHENA_PREPROD_EVIDENCE_DIR:-${state_dir}/evidence}"
bootstrap_image="${ATHENA_PREPROD_BOOTSTRAP_IMAGE:-athena-preproduction-bootstrap:local}"
compose_files=(
  -f "${repo_root}/docker/docker-compose.modular.yml"
  -f "${repo_root}/docker/docker-compose.preproduction.yml"
)

if [[ "${ATHENA_PREPROD_CONFIRM:-}" != "athena-preproduction" ]]; then
  echo "Refusing to deploy without ATHENA_PREPROD_CONFIRM=athena-preproduction" >&2
  exit 2
fi
if [[ "${APP_ENV:-preproduction}" == "production" ]]; then
  echo "Refusing to run the preproduction deployer with APP_ENV=production" >&2
  exit 2
fi

mkdir -p "${secret_dir}" "${evidence_dir}"
chmod 700 "${secret_dir}" "${evidence_dir}"

docker build \
  --target backend-build \
  --tag "${bootstrap_image}" \
  --file "${repo_root}/docker/Dockerfile" \
  "${repo_root}"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "${secret_dir}:/run/preproduction-secrets" \
  --entrypoint node \
  "${bootstrap_image}" \
  /app/server/scripts/provision-micro-module-preproduction.js \
  --output-dir /run/preproduction-secrets \
  --host-output-dir "${secret_dir}" \
  --execute

set -a
# shellcheck disable=SC1090
source "${secret_dir}/runtime.env"
set +a
export ATHENA_PREPROD_SECRETS_DIR="${secret_dir}"
export ATHENA_PREPROD_CONFIRM="athena-preproduction"

docker compose \
  --env-file "${secret_dir}/runtime.env" \
  "${compose_files[@]}" \
  --profile "*" \
  config --quiet

docker compose \
  --env-file "${secret_dir}/runtime.env" \
  "${compose_files[@]}" \
  --profile "*" \
  build

docker compose \
  --env-file "${secret_dir}/runtime.env" \
  "${compose_files[@]}" \
  --profile "*" \
  up -d --remove-orphans

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
container_evidence="/app/server/storage/preproduction/evidence/topology-${timestamp}.json"
docker compose \
  --env-file "${secret_dir}/runtime.env" \
  "${compose_files[@]}" \
  --profile "*" \
  exec -T anything-llm-api \
  node scripts/verify-micro-module-preproduction.js \
  --timeout-ms 300000 \
  --output "${container_evidence}"

api_container_id="$(
  docker compose \
    --env-file "${secret_dir}/runtime.env" \
    "${compose_files[@]}" \
    --profile "*" \
    ps -q anything-llm-api
)"
docker cp \
  "${api_container_id}:${container_evidence}" \
  "${evidence_dir}/topology-${timestamp}.json"
chmod 600 "${evidence_dir}/topology-${timestamp}.json"

echo "Preproduction topology is running."
echo "Topology evidence: ${evidence_dir}/topology-${timestamp}.json"
echo "Production has not been changed."
