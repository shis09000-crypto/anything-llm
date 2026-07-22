#!/usr/bin/env bash
set -euo pipefail

root="${1:-/data/anythingllm}"
secret_dir="${root}/secrets/ai-operations"
env_file="${secret_dir}/compose.env"
nats_box_image="${ATHENA_NATS_BOX_IMAGE:-natsio/nats-box:0.18.0}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root so workload credential ownership can be assigned safely." >&2
  exit 1
fi

install -d -m 0700 -o root -g root "${secret_dir}"

write_random_secret() {
  local target="$1"
  if [[ ! -s "${target}" ]]; then
    umask 077
    openssl rand -hex 32 >"${target}"
  fi
}

write_random_secret "${secret_dir}/clickhouse-password.app"
if [[ ! -s "${secret_dir}/clickhouse-password.server" ]]; then
  cp "${secret_dir}/clickhouse-password.app" "${secret_dir}/clickhouse-password.server"
fi
write_random_secret "${secret_dir}/metrics-token"
write_random_secret "${secret_dir}/grafana-admin-password"

if [[ ! -s "${secret_dir}/nats-client.nkey" ]]; then
  mapfile -t nkey < <(docker run --rm "${nats_box_image}" nsc generate nkey --user)
  if [[ "${#nkey[@]}" -lt 2 || "${nkey[0]}" != SU* || "${nkey[1]}" != U* ]]; then
    echo "NATS user NKey generation failed." >&2
    exit 1
  fi
  printf '%s\n' "${nkey[0]}" >"${secret_dir}/nats-client.nkey"
  printf '%s\n' "${nkey[1]}" >"${secret_dir}/nats-client.public"
  unset nkey
fi

if [[ ! -s "${secret_dir}/ca.pem" ]]; then
  openssl genrsa -out "${secret_dir}/ca.key" 4096 >/dev/null 2>&1
  openssl req -x509 -new -sha256 -days 3650 \
    -key "${secret_dir}/ca.key" \
    -subj "/CN=Athena Operations Internal CA" \
    -out "${secret_dir}/ca.pem" >/dev/null 2>&1
fi

if [[ ! -s "${secret_dir}/nats-server.pem" ]]; then
  openssl genrsa -out "${secret_dir}/nats-server.key" 3072 >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "${secret_dir}/nats-server.key" \
    -subj "/CN=nats" \
    -out "${secret_dir}/nats-server.csr" >/dev/null 2>&1
  printf '%s\n' \
    'subjectAltName=DNS:nats,DNS:athena-production-nats' \
    'extendedKeyUsage=serverAuth' \
    >"${secret_dir}/nats-server.ext"
  openssl x509 -req -sha256 -days 825 \
    -in "${secret_dir}/nats-server.csr" \
    -CA "${secret_dir}/ca.pem" \
    -CAkey "${secret_dir}/ca.key" \
    -CAcreateserial \
    -extfile "${secret_dir}/nats-server.ext" \
    -out "${secret_dir}/nats-server.pem" >/dev/null 2>&1
fi

if [[ ! -s "${secret_dir}/nats-client.pem" ]]; then
  openssl genrsa -out "${secret_dir}/nats-client.key" 3072 >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "${secret_dir}/nats-client.key" \
    -subj "/CN=athena-api-production" \
    -out "${secret_dir}/nats-client.csr" >/dev/null 2>&1
  printf '%s\n' 'extendedKeyUsage=clientAuth' >"${secret_dir}/nats-client.ext"
  openssl x509 -req -sha256 -days 825 \
    -in "${secret_dir}/nats-client.csr" \
    -CA "${secret_dir}/ca.pem" \
    -CAkey "${secret_dir}/ca.key" \
    -CAcreateserial \
    -extfile "${secret_dir}/nats-client.ext" \
    -out "${secret_dir}/nats-client.pem" >/dev/null 2>&1
fi

nats_public_key="$(tr -d '\r\n' <"${secret_dir}/nats-client.public")"
cat >"${secret_dir}/nats-server.conf" <<EOF
server_name: athena-production-nats
port: 4222
http: 8222

jetstream {
  store_dir: "/data/jetstream"
  max_memory_store: 128MB
  max_file_store: 4GB
}

tls {
  cert_file: "/run/secrets/nats_server.pem"
  key_file: "/run/secrets/nats_server.key"
  ca_file: "/run/secrets/athena_nats_ca.pem"
  verify: true
  timeout: 2
}

authorization {
  users: [
    {
      nkey: "${nats_public_key}"
      permissions: {
        publish: ["athena.production.>", "\$JS.API.>", "_INBOX.>"]
        subscribe: ["athena.production.>", "\$JS.API.>", "_INBOX.>"]
      }
    }
  ]
}
EOF

cat >"${env_file}" <<EOF
ATHENA_NATS_CONFIG_FILE=${secret_dir}/nats-server.conf
ATHENA_NATS_NKEY_SEED_HOST_FILE=${secret_dir}/nats-client.nkey
ATHENA_NATS_TLS_CA_HOST_FILE=${secret_dir}/ca.pem
ATHENA_NATS_TLS_CERT_HOST_FILE=${secret_dir}/nats-client.pem
ATHENA_NATS_TLS_KEY_HOST_FILE=${secret_dir}/nats-client.key
ATHENA_NATS_SERVER_CERT_HOST_FILE=${secret_dir}/nats-server.pem
ATHENA_NATS_SERVER_KEY_HOST_FILE=${secret_dir}/nats-server.key
ATHENA_CLICKHOUSE_APP_PASSWORD_FILE=${secret_dir}/clickhouse-password.app
ATHENA_CLICKHOUSE_SERVER_PASSWORD_FILE=${secret_dir}/clickhouse-password.server
ATHENA_METRICS_TOKEN_FILE=${secret_dir}/metrics-token
ATHENA_GRAFANA_ADMIN_USER=athena_admin
ATHENA_GRAFANA_ADMIN_PASSWORD=$(tr -d '\r\n' <"${secret_dir}/grafana-admin-password")
ATHENA_GRAFANA_PORT=53000
EOF

chown root:root "${secret_dir}/ca.key" "${secret_dir}/grafana-admin-password" "${env_file}"
chmod 0400 "${secret_dir}/ca.key" "${secret_dir}/grafana-admin-password" "${env_file}"

chown 1000:1000 \
  "${secret_dir}/clickhouse-password.app" \
  "${secret_dir}/metrics-token" \
  "${secret_dir}/nats-client.nkey" \
  "${secret_dir}/nats-client.key" \
  "${secret_dir}/nats-server.key"
chmod 0400 \
  "${secret_dir}/clickhouse-password.app" \
  "${secret_dir}/metrics-token" \
  "${secret_dir}/nats-client.nkey" \
  "${secret_dir}/nats-client.key" \
  "${secret_dir}/nats-server.key"

chown 101:101 "${secret_dir}/clickhouse-password.server"
chmod 0400 "${secret_dir}/clickhouse-password.server"

chown root:root \
  "${secret_dir}/ca.pem" \
  "${secret_dir}/nats-client.pem" \
  "${secret_dir}/nats-server.pem" \
  "${secret_dir}/nats-server.conf" \
  "${secret_dir}/nats-client.public"
chmod 0444 \
  "${secret_dir}/ca.pem" \
  "${secret_dir}/nats-client.pem" \
  "${secret_dir}/nats-server.pem" \
  "${secret_dir}/nats-server.conf" \
  "${secret_dir}/nats-client.public"

rm -f \
  "${secret_dir}/nats-server.csr" \
  "${secret_dir}/nats-server.ext" \
  "${secret_dir}/nats-client.csr" \
  "${secret_dir}/nats-client.ext" \
  "${secret_dir}/ca.srl"

echo "Athena Operations secrets provisioned at ${secret_dir}."
