#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_dir="${ATHENA_PREPROD_STATE_DIR:-/data/athena-preproduction}"
secret_dir="${ATHENA_PREPROD_SECRETS_DIR:-${state_dir}/secrets}"
evidence_dir="${ATHENA_PREPROD_EVIDENCE_DIR:-${state_dir}/evidence}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
expected_modules="$(node -e "const {loadManifests}=require('${repo_root}/server/utils/modulePlatform/manifestRegistry'); process.stdout.write(String(loadManifests().length))")"
compose_files=(
  -f "${repo_root}/docker/docker-compose.modular.yml"
  -f "${repo_root}/docker/docker-compose.preproduction.yml"
)

if [[ "${ATHENA_PREPROD_CONFIRM:-}" != "athena-preproduction" ]]; then
  echo "Refusing to run without ATHENA_PREPROD_CONFIRM=athena-preproduction" >&2
  exit 2
fi
if [[ "${APP_ENV:-preproduction}" == "production" ]]; then
  echo "Refusing to run preproduction drills with APP_ENV=production" >&2
  exit 2
fi

test -f "${secret_dir}/runtime.env"
mkdir -p "${evidence_dir}"
chmod 700 "${evidence_dir}"
set -a
# shellcheck disable=SC1090
source "${secret_dir}/runtime.env"
set +a
export ATHENA_PREPROD_SECRETS_DIR="${secret_dir}"
export ATHENA_PREPROD_CONFIRM="athena-preproduction"

compose() {
  docker compose \
    --env-file "${secret_dir}/runtime.env" \
    "${compose_files[@]}" \
    --profile "*" \
    "$@"
}

copy_from_api() {
  local container_path="$1"
  local host_path="$2"
  local api_container_id
  api_container_id="$(compose ps -q anything-llm-api)"
  docker cp "${api_container_id}:${container_path}" "${host_path}"
  chmod 600 "${host_path}"
}

verify_topology() {
  local label="$1"
  local container_path="/app/server/evidence/topology-${label}-${timestamp}.json"
  local host_path="${evidence_dir}/topology-${label}-${timestamp}.json"
  compose exec -T anything-llm-api \
    node scripts/verify-micro-module-preproduction.js \
    --timeout-ms 180000 \
    --output "${container_path}" >/dev/null
  copy_from_api "${container_path}" "${host_path}"
  printf '%s' "${host_path}"
}

initial_topology="$(verify_topology initial)"

protected_services=(
  anything-llm-api
  anything-llm-chat-runtime
  anything-llm-agent-runtime
  anything-llm-realtime-gateway
)
rolling_targets=(
  anything-llm-reader-worker
  anything-llm-tool-broker
  anything-llm-crypto-forecast
  anything-llm-browser-plane
  anything-llm-browser-worker
)
before_ids="$(mktemp)"
after_ids="$(mktemp)"
target_before="$(mktemp)"
target_after="$(mktemp)"
realtime_stopped=false
crypto_market_stopped=false
cleanup() {
  if [[ "${realtime_stopped}" == "true" ]]; then
    compose start anything-llm-realtime-gateway >/dev/null 2>&1 || true
  fi
  if [[ "${crypto_market_stopped}" == "true" ]]; then
    compose start anything-llm-crypto-market >/dev/null 2>&1 || true
  fi
  rm -f "${before_ids}" "${after_ids}" "${target_before}" "${target_after}"
}
trap cleanup EXIT

for service in "${protected_services[@]}"; do
  printf '%s|%s\n' "${service}" "$(compose ps -q "${service}")" >>"${before_ids}"
done
for service in "${rolling_targets[@]}"; do
  printf '%s|%s\n' "${service}" "$(compose ps -q "${service}")" >>"${target_before}"
  compose up -d --no-deps --force-recreate "${service}" >/dev/null
  verify_topology "rolling-${service}" >/dev/null
done
for service in "${protected_services[@]}"; do
  printf '%s|%s\n' "${service}" "$(compose ps -q "${service}")" >>"${after_ids}"
done
for service in "${rolling_targets[@]}"; do
  printf '%s|%s\n' "${service}" "$(compose ps -q "${service}")" >>"${target_after}"
done

protected_unchanged=false
targets_recreated=false
if cmp -s "${before_ids}" "${after_ids}"; then
  protected_unchanged=true
fi
all_targets_recreated=true
while IFS='|' read -r service before_id; do
  after_id="$(awk -F '|' -v service="${service}" '$1 == service { print $2 }' "${target_after}")"
  if [[ -z "${before_id}" || -z "${after_id}" || "${before_id}" == "${after_id}" ]]; then
    all_targets_recreated=false
  fi
done <"${target_before}"
if [[ "${all_targets_recreated}" == "true" ]]; then
  targets_recreated=true
fi
rolling_topology="$(verify_topology rolling-recovered)"
rolling_evidence="${evidence_dir}/rolling-release-${timestamp}.json"
PROTECTED_UNCHANGED="${protected_unchanged}" \
TARGETS_RECREATED="${targets_recreated}" \
EXPECTED_MODULES="${expected_modules}" \
node - "${rolling_evidence}" <<'NODE'
const fs = require("fs");
const target = process.argv[2];
const protectedServicesUnchanged =
  process.env.PROTECTED_UNCHANGED === "true";
const targetServicesRecreated = process.env.TARGETS_RECREATED === "true";
const evidence = {
  version: "athena.preproduction-rolling-release-drill:v1",
  generatedAt: new Date().toISOString(),
  environment: "preproduction",
  passed:
    protectedServicesUnchanged && targetServicesRecreated,
  protectedServicesUnchanged,
  targetServicesRecreated,
  recoveredAllModules: true,
  expectedModules: Number(process.env.EXPECTED_MODULES),
  updatedModules: ["reader-worker", "tool-runtime", "crypto-forecast", "browser-plane", "browser-worker"],
  productionChanged: false,
};
fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
if (!evidence.passed) process.exitCode = 2;
NODE

nats_state="/app/server/evidence/nats-replay-${timestamp}.json"
compose exec -T anything-llm-api \
  node scripts/drill-nats-disconnect-recovery.js \
  --phase prepare --state "${nats_state}" >/dev/null
compose stop anything-llm-realtime-gateway >/dev/null
realtime_stopped=true
compose exec -T anything-llm-api \
  node scripts/drill-nats-disconnect-recovery.js \
  --phase gap --state "${nats_state}" >/dev/null
compose start anything-llm-realtime-gateway >/dev/null
realtime_stopped=false
compose exec -T anything-llm-api \
  node scripts/drill-nats-disconnect-recovery.js \
  --phase verify --state "${nats_state}" >/dev/null
disconnect_topology="$(verify_topology disconnect-recovered)"
nats_host_state="${evidence_dir}/nats-replay-${timestamp}.json"
copy_from_api "${nats_state}" "${nats_host_state}"
disconnect_evidence="${evidence_dir}/disconnect-recovery-${timestamp}.json"
NATS_STATE="${nats_host_state}" EXPECTED_MODULES="${expected_modules}" node - "${disconnect_evidence}" <<'NODE'
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.env.NATS_STATE, "utf8"));
const evidence = {
  version: "athena.preproduction-disconnect-recovery-drill:v1",
  generatedAt: new Date().toISOString(),
  environment: "preproduction",
  passed:
    state.durableSequenceReplayVerified === true &&
    state.duplicateEvents === 0 &&
    state.missingEvents === 0,
  streamGatewayRestarted: true,
  durableSequenceReplayVerified:
    state.durableSequenceReplayVerified === true,
  duplicateEvents: Number(state.duplicateEvents || 0),
  missingEvents: Number(state.missingEvents || 0),
  recoveredAllModules: true,
  expectedModules: Number(process.env.EXPECTED_MODULES),
  productionChanged: false,
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
if (!evidence.passed) process.exitCode = 2;
NODE

compose stop anything-llm-crypto-market >/dev/null
crypto_market_stopped=true
fault_inner="/app/server/evidence/fault-inner-${timestamp}.json"
compose exec -T anything-llm-api \
  node scripts/verify-micro-module-fault-scope.js \
  --target crypto-market \
  --timeout-ms 90000 \
  --output "${fault_inner}" >/dev/null
compose start anything-llm-crypto-market >/dev/null
crypto_market_stopped=false
fault_topology="$(verify_topology fault-recovered)"
fault_inner_host="${evidence_dir}/fault-inner-${timestamp}.json"
copy_from_api "${fault_inner}" "${fault_inner_host}"
fault_evidence="${evidence_dir}/service-fault-${timestamp}.json"
FAULT_INNER="${fault_inner_host}" EXPECTED_MODULES="${expected_modules}" node - "${fault_evidence}" <<'NODE'
const fs = require("fs");
const inner = JSON.parse(fs.readFileSync(process.env.FAULT_INNER, "utf8"));
const evidence = {
  version: "athena.preproduction-service-fault-drill:v1",
  generatedAt: new Date().toISOString(),
  environment: "preproduction",
  passed:
    inner.targetDegraded === true &&
    inner.protectedModulesHealthy === true,
  target: inner.target,
  targetDegraded: inner.targetDegraded === true,
  protectedModulesHealthy: inner.protectedModulesHealthy === true,
  faultScopeContained: inner.protectedModulesHealthy === true,
  recoveredAllModules: true,
  expectedModules: Number(process.env.EXPECTED_MODULES),
  productionChanged: false,
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
if (!evidence.passed) process.exitCode = 2;
NODE

"${repo_root}/scripts/preproduction/drill-backup-restore.sh" >/dev/null
backup_evidence="$(find "${evidence_dir}" -maxdepth 1 -name 'backup-restore-*.json' -type f -print | LC_ALL=C sort | tail -n 1)"

crypto_container="/app/server/evidence/crypto-isolation-${timestamp}.json"
compose exec -T anything-llm-api \
  sh -ec "node scripts/drill-crypto-account-isolation.js > '${crypto_container}'"
crypto_preflight_evidence="${evidence_dir}/crypto-isolation-preflight-${timestamp}.json"
copy_from_api "${crypto_container}" "${crypto_preflight_evidence}"

if [[ -z "${ATHENA_PREPROD_CHAT_AGENT_DRILL_EVIDENCE:-}" ]]; then
  echo "ATHENA_PREPROD_CHAT_AGENT_DRILL_EVIDENCE is required for real in-flight Chat/Agent qualification." >&2
  echo "Topology and infrastructure drill evidence were retained; formal cutover evidence was not generated." >&2
  exit 3
fi
if [[ -z "${ATHENA_PREPROD_CRYPTO_ISOLATION_EVIDENCE:-}" ]]; then
  echo "ATHENA_PREPROD_CRYPTO_ISOLATION_EVIDENCE is required for the real two-account Tool Broker -> Crypto Account qualification." >&2
  echo "Registry preflight evidence was retained at ${crypto_preflight_evidence}; it is not accepted as cutover evidence." >&2
  exit 3
fi
chat_agent_evidence="$(realpath "${ATHENA_PREPROD_CHAT_AGENT_DRILL_EVIDENCE}")"
crypto_evidence="$(realpath "${ATHENA_PREPROD_CRYPTO_ISOLATION_EVIDENCE}")"
test -f "${chat_agent_evidence}"
test -f "${crypto_evidence}"

cutover_evidence="${evidence_dir}/cutover-qualification-${timestamp}.json"
APP_ENV=preproduction node \
  "${repo_root}/server/scripts/generate-preproduction-cutover-evidence.js" \
  --topology "${fault_topology}" \
  --rolling "${rolling_evidence}" \
  --disconnect "${disconnect_evidence}" \
  --fault "${fault_evidence}" \
  --backup "${backup_evidence}" \
  --crypto "${crypto_evidence}" \
  --chat-agent "${chat_agent_evidence}" \
  --output "${cutover_evidence}"

echo "Initial topology evidence: ${initial_topology}"
echo "Rolling recovery topology: ${rolling_topology}"
echo "Disconnect recovery topology: ${disconnect_topology}"
echo "Fault recovery topology: ${fault_topology}"
echo "Formal preproduction qualification: ${cutover_evidence}"
echo "Production has not been changed."
