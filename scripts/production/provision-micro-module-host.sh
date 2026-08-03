#!/usr/bin/env bash
set -euo pipefail

state_dir="${ATHENA_PROD_STATE_DIR:-/data/anythingllm/micro-modular}"
legacy_env="${ATHENA_PROD_LEGACY_ENV:-/data/anythingllm/app/docker/.env}"
legacy_secret_dir="${ATHENA_PROD_LEGACY_SECRET_DIR:-/data/anythingllm/secrets}"
legacy_nats_seed="${ATHENA_PROD_LEGACY_NATS_SEED:-${legacy_secret_dir}/ai-operations/nats-client.nkey}"
backend_image="${ATHENA_PROD_BACKEND_IMAGE:-anythingllm-v2-anythingllm:latest}"
browser_worker_image="${ATHENA_PROD_BROWSER_WORKER_IMAGE:-anythingllm-v2-browser-worker:latest}"
repo_dir="${ATHENA_PROD_REPO_DIR:-/data/anythingllm/app}"
compose_dir="${ATHENA_PROD_COMPOSE_DIR:-/data/anythingllm/compose/micro-modular}"
browser_seccomp_source="${repo_dir}/docker/playwright-seccomp-profile.json"

if [[ "${ATHENA_PROD_CONFIRM:-}" != "athena-production-micro" ]]; then
  echo "Refusing to provision without ATHENA_PROD_CONFIRM=athena-production-micro" >&2
  exit 1
fi
if [[ ! -s "${legacy_env}" ]]; then
  echo "Legacy production environment is missing." >&2
  exit 1
fi
if [[ ! -s "${browser_seccomp_source}" ]]; then
  echo "Browser Worker seccomp policy is missing from the release source." >&2
  exit 1
fi
if ! jq empty "${browser_seccomp_source}" >/dev/null 2>&1; then
  echo "Browser Worker seccomp policy is not valid JSON." >&2
  exit 1
fi

install -d -m 0755 "${compose_dir}"
install -m 0644 "${browser_seccomp_source}" \
  "${compose_dir}/playwright-seccomp-profile.json"

secrets_dir="${state_dir}/secrets"
runtime_secret_dir="${secrets_dir}/runtime-secrets"
mtls_dir="${secrets_dir}/service-mtls"
nats_dir="${secrets_dir}/nats"
capability_dir="${secrets_dir}/plugin-capability"
private_dir="${secrets_dir}/bootstrap-private"
runtime_env="${secrets_dir}/runtime.env"
agent_runtime_env="${secrets_dir}/runtime-agent.env"
compose_env="${secrets_dir}/compose.env"

install -d -m 0700 "${state_dir}" "${secrets_dir}" "${runtime_secret_dir}" \
  "${mtls_dir}" "${nats_dir}" "${capability_dir}" "${private_dir}" \
  "${state_dir}/postgresql" "${state_dir}/minio" "${state_dir}/web"

read_env() {
  local name="$1"
  awk -v key="${name}" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value=$0; sub("^[^=]*=", "", value); gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, "", value); print value; exit
    }
  ' "${legacy_env}"
}

private_copy() {
  local source="$1" target="$2"
  if [[ ! -e "${target}" ]]; then
    install -m 0600 "${source}" "${target}"
  fi
}

public_copy() {
  local source="$1" target="$2"
  if [[ ! -e "${target}" ]]; then
    install -m 0644 "${source}" "${target}"
  fi
}

if [[ ! -s "${runtime_secret_dir}/master-key" ]]; then
  master_key="$(read_env ENCRYPTION_MASTER_KEY)"
  if [[ ! "${master_key}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Existing production master key is invalid; refusing replacement." >&2
    exit 1
  fi
  umask 077
  printf '%s\n' "${master_key}" >"${runtime_secret_dir}/master-key"
  unset master_key
fi
private_copy "${legacy_secret_dir}/password/athena_password_pepper" "${runtime_secret_dir}/password-pepper"
public_copy "${legacy_secret_dir}/ai-operations/ca.pem" "${mtls_dir}/ca.pem"
private_copy "${legacy_secret_dir}/ai-operations/ca.key" "${private_dir}/service-ca.key"
private_copy "${legacy_secret_dir}/ai-operations/metrics-token" "${runtime_secret_dir}/metrics-token"
if [[ -d "${runtime_secret_dir}/clickhouse-password" ]]; then
  nested_password="${runtime_secret_dir}/clickhouse-password/clickhouse-password.server"
  if [[ ! -f "${nested_password}" ]] || \
     ! cmp -s "${legacy_secret_dir}/ai-operations/clickhouse-password.server" \
       "${nested_password}"; then
    echo "Unexpected content in ClickHouse password mount path." >&2
    exit 1
  fi
  rm -f "${nested_password}"
  rmdir "${runtime_secret_dir}/clickhouse-password"
fi
private_copy "${legacy_secret_dir}/ai-operations/clickhouse-password.server" \
  "${runtime_secret_dir}/clickhouse-password"

unique_pq_secret() {
  local name="$1"
  local -a matches=()
  while IFS= read -r match; do matches+=("${match}"); done < <(
    find "${legacy_secret_dir}/pq-signing" -mindepth 2 -maxdepth 2 \
      -type f -name "${name}" -print 2>/dev/null | sort
  )
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one ${name} legacy PQ signing key, found ${#matches[@]}." >&2
    exit 1
  fi
  printf '%s' "${matches[0]}"
}

private_copy "$(unique_pq_secret audit-mldsa65-private.pem)" \
  "${runtime_secret_dir}/audit-mldsa65-private.pem"
public_copy "$(unique_pq_secret audit-mldsa65-public.pem)" \
  "${runtime_secret_dir}/audit-mldsa65-public.pem"
private_copy "$(unique_pq_secret agent-registry-mldsa65-private.pem)" \
  "${runtime_secret_dir}/agent-mldsa65-private.pem"
public_copy "$(unique_pq_secret agent-registry-mldsa65-public.pem)" \
  "${runtime_secret_dir}/agent-mldsa65-public.pem"

if [[ ! -s "${runtime_secret_dir}/nats-subject-key" ]]; then
  umask 077
  openssl rand -hex 32 >"${runtime_secret_dir}/nats-subject-key"
fi

roles=(
  api background-worker realtime-gateway reader-worker scheduler
  operations-plane chat-runtime agent-runtime model-gateway responses-runtime tool-broker
  crypto-market crypto-account crypto-forecast key-custody collector edge-web
  identity knowledge-ingest rag operations-shadow-agents prometheus minio
  browser-plane browser-worker browser-egress coordination-plane
)

dns_for_role() {
  case "$1" in
    api) printf '%s' 'anything-llm-api,anything-llm-api-tls,api' ;;
    background-worker) printf '%s' 'anything-llm-background-worker,background-worker' ;;
    realtime-gateway) printf '%s' 'anything-llm-realtime-gateway,realtime-gateway' ;;
    reader-worker) printf '%s' 'anything-llm-reader-worker,reader-worker' ;;
    scheduler) printf '%s' 'anything-llm-scheduler,scheduler' ;;
    operations-plane) printf '%s' 'anything-llm-operations-plane,operations-plane' ;;
    chat-runtime) printf '%s' 'anything-llm-chat-runtime,chat-runtime' ;;
    agent-runtime) printf '%s' 'anything-llm-agent-runtime,agent-runtime' ;;
    model-gateway) printf '%s' 'anything-llm-model-gateway,model-gateway' ;;
    responses-runtime) printf '%s' 'anything-llm-responses-runtime,responses-runtime' ;;
    tool-broker) printf '%s' 'anything-llm-tool-broker,tool-broker' ;;
    crypto-market) printf '%s' 'anything-llm-crypto-market,crypto-market' ;;
    crypto-account) printf '%s' 'anything-llm-crypto-account,crypto-account' ;;
    crypto-forecast) printf '%s' 'anything-llm-crypto-forecast,crypto-forecast' ;;
    key-custody) printf '%s' 'anything-llm-key-custody,key-custody' ;;
    collector) printf '%s' 'anything-llm-collector,collector' ;;
    edge-web) printf '%s' 'anything-llm-edge-probe,anything-llm-web,edge-web' ;;
    identity) printf '%s' 'anything-llm-identity,identity' ;;
    knowledge-ingest) printf '%s' 'anything-llm-knowledge-ingest,knowledge-ingest' ;;
    rag) printf '%s' 'anything-llm-rag,rag' ;;
    operations-shadow-agents) printf '%s' 'anything-llm-operations-shadow-agents,operations-shadow-agents' ;;
    browser-plane) printf '%s' 'anything-llm-browser-plane,browser-plane' ;;
    browser-worker) printf '%s' 'anything-llm-browser-worker,browser-worker' ;;
    browser-egress) printf '%s' 'anything-llm-browser-egress,browser-egress' ;;
    coordination-plane) printf '%s' 'anything-llm-coordination-plane,coordination-plane' ;;
    prometheus) printf '%s' 'anything-llm-prometheus,prometheus' ;;
    minio) printf '%s' 'minio' ;;
  esac
}

ca_serial="${private_dir}/service-ca.srl"
for role in "${roles[@]}"; do
  key="${mtls_dir}/${role}.key"
  cert="${mtls_dir}/${role}.pem"
  [[ -s "${key}" && -s "${cert}" ]] && continue
  if [[ -e "${key}" || -e "${cert}" ]]; then
    echo "Incomplete certificate pair for ${role}." >&2
    exit 1
  fi
  csr="${private_dir}/${role}.csr"
  ext="${private_dir}/${role}.ext"
  san="URI:spiffe://athena/production/${role}"
  IFS=',' read -r -a dns_names <<<"$(dns_for_role "${role}")"
  for dns in "${dns_names[@]}"; do san="${san},DNS:${dns}"; done
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "${key}" -out "${csr}" -subj "/CN=${role}" >/dev/null 2>&1
  printf '%s\n' \
    "subjectAltName=${san}" \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=clientAuth,serverAuth' >"${ext}"
  serial_args=(-CAserial "${ca_serial}")
  [[ -s "${ca_serial}" ]] || serial_args=(-CAcreateserial -CAserial "${ca_serial}")
  openssl x509 -req -in "${csr}" -CA "${mtls_dir}/ca.pem" \
    -CAkey "${private_dir}/service-ca.key" "${serial_args[@]}" \
    -out "${cert}" -days 30 -sha256 -extfile "${ext}" >/dev/null 2>&1
  chmod 0600 "${key}"
  chmod 0644 "${cert}"
done

docker run --rm --user 0:0 --workdir /app/server \
  --volume "${nats_dir}:/out" --entrypoint node "${backend_image}" -e '
    const fs=require("fs"), nkeys=require("nkeys.js");
    const roles=process.argv[1].split(",");
    for (const role of roles) {
      const file=`/out/${role}.nk`;
      if (fs.existsSync(file)) continue;
      const pair=nkeys.createUser();
      fs.writeFileSync(file, pair.getSeed(), {mode:0o600,flag:"wx"});
    }
    console.log(JSON.stringify({success:true,nkeyFiles:roles.length}));
  ' "$(IFS=,; echo "${roles[*]}")"

docker run --rm --user 0:0 --workdir /app/server \
  --volume "${nats_dir}:/out" \
  --volume "${legacy_nats_seed}:/run/legacy.nk:ro" \
  --entrypoint node "${backend_image}" -e '
    const fs=require("fs"),nkeys=require("nkeys.js");
    const roles=process.argv[1].split(",");
    const publicKeys=new Set();
    publicKeys.add(nkeys.fromSeed(fs.readFileSync("/run/legacy.nk")).getPublicKey());
    for (const role of roles) publicKeys.add(nkeys.fromSeed(fs.readFileSync(`/out/${role}.nk`)).getPublicKey());
    const permission=`["athena.production.>", "$JS.API.>", "$JS.ACK.>", "_INBOX.>"]`;
    const users=[...publicKeys].map(key=>`    { nkey: "${key}", permissions: { publish: ${permission}, subscribe: ${permission} } }`);
    const config=[
      "server_name: athena-production-nats", "port: 4222", "http: 8222", "",
      "jetstream {", "  store_dir: \"/data/jetstream\"", "  max_memory_store: 128MB", "  max_file_store: 4GB", "}", "",
      "tls {", "  cert_file: \"/run/secrets/nats_server.pem\"", "  key_file: \"/run/secrets/nats_server.key\"", "  ca_file: \"/run/secrets/athena_nats_ca.pem\"", "  verify: true", "  timeout: 2", "}", "",
      "authorization {", "  users: [", ...users, "  ]", "}", ""
    ].join("\n");
    fs.writeFileSync("/out/nats-server.production.candidate.conf",config,{mode:0o644});
    console.log(JSON.stringify({success:true,natsAuthorizedIdentities:publicKeys.size}));
  ' "$(IFS=,; echo "${roles[*]}")"

docker run --rm --user 0:0 --workdir /app/server \
  --volume "${capability_dir}:/out" --entrypoint node "${backend_image}" -e '
    const fs=require("fs"),crypto=require("crypto");
    for (const [name,algorithm] of [["ed25519","ed25519"],["mldsa65","ml-dsa-65"]]) {
      const privateFile=`/out/${name}-private.pem`, publicFile=`/out/${name}-public.pem`;
      if (fs.existsSync(privateFile)&&fs.existsSync(publicFile)) continue;
      if (fs.existsSync(privateFile)||fs.existsSync(publicFile)) throw new Error(`incomplete:${name}`);
      const pair=crypto.generateKeyPairSync(algorithm);
      fs.writeFileSync(privateFile,pair.privateKey.export({format:"pem",type:"pkcs8"}),{mode:0o600,flag:"wx"});
      fs.writeFileSync(publicFile,pair.publicKey.export({format:"pem",type:"spki"}),{mode:0o644,flag:"wx"});
    }
    console.log(JSON.stringify({success:true,hybridCapabilityKeys:true}));
  '

if [[ ! -s "${runtime_env}" ]]; then
  awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ && $1 != "ENCRYPTION_MASTER_KEY" && $1 != "ATHENA_MASTER_KEY_FILE" && $1 != "ATHENA_KEY_LEASE_FILE" { print }
  ' "${legacy_env}" >"${runtime_env}"
  chmod 0600 "${runtime_env}"
fi
if [[ ! -s "${agent_runtime_env}" ]]; then
  awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ &&
      $1 != "ENCRYPTION_MASTER_KEY" &&
      $1 != "ATHENA_MASTER_KEY_FILE" &&
      $1 != "ATHENA_KEY_LEASE_FILE" &&
      $1 !~ /API_KEY/ &&
      $1 !~ /_KEY_ENCRYPTED$/ &&
      $1 != "EMAIL_SMTP_PASSWORD" { print }
  ' "${legacy_env}" >"${agent_runtime_env}"
  chmod 0600 "${agent_runtime_env}"
fi

random_secret() { openssl rand -base64 "$1" | tr -d '\n' | tr '/+' '_-'; }
ensure_env() {
  local key="$1" value="$2"
  grep -q "^${key}=" "${compose_env}" 2>/dev/null || printf '%s=%s\n' "${key}" "${value}" >>"${compose_env}"
}
if [[ ! -e "${compose_env}" ]]; then
  install -m 0600 /dev/null "${compose_env}"
fi
ensure_env ATHENA_PROD_STATE_DIR "${state_dir}"
ensure_env ATHENA_PROD_SECRETS_DIR "${secrets_dir}"
ensure_env ATHENA_PROD_RUNTIME_ENV "${runtime_env}"
ensure_env ATHENA_PROD_AGENT_RUNTIME_ENV "${agent_runtime_env}"
ensure_env ATHENA_PROD_REPO_DIR "${repo_dir}"
ensure_env ATHENA_PROD_STORAGE_DIR /data/anythingllm/storage
ensure_env ATHENA_PROD_COLLECTOR_HOTDIR /data/anythingllm/collector/hotdir
ensure_env ATHENA_PROD_COLLECTOR_OUTPUTS /data/anythingllm/collector/outputs
ensure_env ATHENA_PROD_WEB_ROOT "${state_dir}/web/current"
ensure_env ATHENA_PROD_BACKEND_IMAGE "${backend_image}"
ensure_env ATHENA_PROD_BROWSER_WORKER_IMAGE "${browser_worker_image}"
module_backend_image="$(awk -F= '$1 == "ATHENA_PROD_BACKEND_IMAGE" { sub(/^[^=]*=/, ""); print; exit }' "${compose_env}")"
module_browser_worker_image="$(awk -F= '$1 == "ATHENA_PROD_BROWSER_WORKER_IMAGE" { sub(/^[^=]*=/, ""); print; exit }' "${compose_env}")"
module_image_variables=(
  ATHENA_PROD_API_IMAGE
  ATHENA_PROD_EDGE_PROBE_IMAGE
  ATHENA_PROD_BACKGROUND_WORKER_IMAGE
  ATHENA_PROD_REALTIME_GATEWAY_IMAGE
  ATHENA_PROD_READER_WORKER_IMAGE
  ATHENA_PROD_SCHEDULER_IMAGE
  ATHENA_PROD_OPERATIONS_PLANE_IMAGE
  ATHENA_PROD_CHAT_RUNTIME_IMAGE
  ATHENA_PROD_AGENT_RUNTIME_IMAGE
  ATHENA_PROD_MODEL_GATEWAY_IMAGE
  ATHENA_PROD_RESPONSES_RUNTIME_IMAGE
  ATHENA_PROD_TOOL_BROKER_IMAGE
  ATHENA_PROD_CRYPTO_MARKET_IMAGE
  ATHENA_PROD_CRYPTO_ACCOUNT_IMAGE
  ATHENA_PROD_CRYPTO_FORECAST_IMAGE
  ATHENA_PROD_KEY_CUSTODY_IMAGE
  ATHENA_PROD_IDENTITY_IMAGE
  ATHENA_PROD_KNOWLEDGE_INGEST_IMAGE
  ATHENA_PROD_RAG_IMAGE
  ATHENA_PROD_OPERATIONS_SHADOW_AGENTS_IMAGE
  ATHENA_PROD_BROWSER_PLANE_IMAGE
  ATHENA_PROD_COLLECTOR_IMAGE
)
for module_image_variable in "${module_image_variables[@]}"; do
  ensure_env "${module_image_variable}" "${module_backend_image}"
done
ensure_env ATHENA_PROD_BROWSER_WORKER_IMAGE "${module_browser_worker_image}"
ensure_env ATHENA_PROD_NETWORK anythingllm-v2_default
ensure_env ATHENA_PROD_POSTGRES_ADMIN_PASSWORD "$(random_secret 36)"
ensure_env ATHENA_PROD_POSTGRES_MAIN_PASSWORD "$(random_secret 36)"
ensure_env ATHENA_PROD_POSTGRES_AUTH_PASSWORD "$(random_secret 36)"
ensure_env ATHENA_PROD_MINIO_ROOT_USER "athena_$(openssl rand -hex 8)"
ensure_env ATHENA_PROD_MINIO_ROOT_PASSWORD "$(random_secret 36)"
ensure_env ATHENA_PROD_S3_ACCESS_KEY "$(openssl rand -hex 18)"
ensure_env ATHENA_PROD_S3_SECRET_KEY "$(random_secret 36)"
ensure_env ATHENA_PROD_AUTH_TOKEN "$(read_env AUTH_TOKEN)"
ensure_env ATHENA_PROD_JWT_SECRET "$(read_env JWT_SECRET)"
ensure_env ATHENA_PROD_SIG_KEY "$(read_env SIG_KEY)"
ensure_env ATHENA_PROD_SIG_SALT "$(read_env SIG_SALT)"
ensure_env ATHENA_PROD_AUDIT_MLDSA65_KEY_ID \
  "${ATHENA_PROD_AUDIT_MLDSA65_KEY_ID:-audit-mldsa65-2026-v1}"
ensure_env ATHENA_PROD_AUDIT_MLDSA65_HARDWARE_PROTECTION \
  "${ATHENA_PROD_AUDIT_MLDSA65_HARDWARE_PROTECTION:-software-protected}"
ensure_env ATHENA_PROD_AGENT_MLDSA65_KEY_ID \
  "${ATHENA_PROD_AGENT_MLDSA65_KEY_ID:-agent-registry-mldsa65-2026-v1}"
chmod 0600 "${compose_env}"

chown -R 1000:1000 "${secrets_dir}"
find "${secrets_dir}" -type d -exec chmod 0700 {} +
find "${secrets_dir}" -type f -name '*.pem' -exec chmod 0644 {} +
find "${secrets_dir}" -type f \( -name '*.key' -o -name '*.nk' -o -name '*.env' -o -name '*-private.pem' -o -name 'master-key' -o -name 'password-pepper' -o -name 'nats-subject-key' -o -name 'metrics-token' \) -exec chmod 0600 {} +

# Prometheus runs as uid/gid 65534. Keep every other service secret private,
# but allow that dedicated identity to traverse the certificate mount and read
# only its own client key plus the metrics bearer token.
chmod 0755 "${mtls_dir}"
chown 1000:65534 "${mtls_dir}/prometheus.key" "${runtime_secret_dir}/metrics-token"
chmod 0640 "${mtls_dir}/prometheus.key" "${runtime_secret_dir}/metrics-token"

echo "Production micro-module secrets provisioned without rotating existing account, JWT, password-pepper, or platform master-key material."
echo "Browser Worker seccomp policy installed as a versioned deployment dependency."
