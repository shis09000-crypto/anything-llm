#!/usr/bin/env bash
set -euo pipefail

compose_file="${ATHENA_PROD_COMPOSE_FILE:-/data/anythingllm/compose/micro-modular/docker-compose.production-micro.json}"
env_file="${ATHENA_PROD_COMPOSE_ENV:-/data/anythingllm/micro-modular/secrets/compose.env}"
project="${ATHENA_PROD_COMPOSE_PROJECT:-athena-production-micro}"
init_script="${ATHENA_PROD_POSTGRES_INIT_SCRIPT:-/data/anythingllm/app/docker/postgresql/init-athena.sh}"

if [[ "${ATHENA_PROD_CONFIRM:-}" != "athena-production-micro" ]]; then
  echo "Refusing database role provisioning without ATHENA_PROD_CONFIRM=athena-production-micro" >&2
  exit 1
fi
for file in "$compose_file" "$env_file" "$init_script"; do
  if [[ ! -s "$file" ]]; then
    echo "production_database_role_input_missing:$file" >&2
    exit 2
  fi
done

compose=(docker compose --env-file "$env_file" -p "$project" -f "$compose_file")
postgres_container="$("${compose[@]}" ps -q postgresql)"
if [[ -z "$postgres_container" ]]; then
  echo "production_postgresql_not_running" >&2
  exit 2
fi

# The checked-in initializer is deliberately idempotent. Running it through
# the live PostgreSQL container gives existing installations the same roles,
# logical schemas, and default privileges as a fresh installation without
# exporting database passwords to the host process or logs.
"${compose[@]}" exec -T postgresql sh -s <"$init_script" >/dev/null

expected_roles='athena_main_observer athena_auth_observer athena_identity athena_key_custody athena_workspace athena_chat athena_agent athena_model_runtime athena_tools athena_crypto_market athena_crypto_account athena_crypto_forecast athena_browser_plane athena_knowledge_query athena_knowledge_ingest athena_knowledge_reader athena_maintenance athena_scheduler athena_sync'
actual_roles="$("${compose[@]}" exec -T postgresql sh -ceu '
  psql -X -qAt --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --set expected="$1" <<'"'"'SQL'"'"'
WITH expected(role_name) AS (
  SELECT unnest(string_to_array(:'"'"'expected'"'"', '"'"' '"'"'))
)
SELECT role_name
  FROM expected
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = expected.role_name
 )
 ORDER BY role_name;
SQL
' sh "$expected_roles")"
if [[ -n "$actual_roles" ]]; then
  echo "production_module_database_roles_missing" >&2
  exit 1
fi

printf '%s\n' '{"success":true,"databaseRoles":"provisioned","passwordsExposed":false}'
