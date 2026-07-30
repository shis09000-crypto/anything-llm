#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_dir="${ATHENA_PREPROD_STATE_DIR:-/data/athena-preproduction}"
secret_dir="${ATHENA_PREPROD_SECRETS_DIR:-${state_dir}/secrets}"
evidence_dir="${ATHENA_PREPROD_EVIDENCE_DIR:-${state_dir}/evidence}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_suffix="$(date -u +%Y%m%d%H%M%S)"
main_restore="athena_restore_main_${restore_suffix}"
auth_restore="athena_restore_auth_${restore_suffix}"
compose_files=(
  -f "${repo_root}/docker/docker-compose.modular.yml"
  -f "${repo_root}/docker/docker-compose.preproduction.yml"
)

if [[ "${ATHENA_PREPROD_CONFIRM:-}" != "athena-preproduction" ]]; then
  echo "Refusing to run without ATHENA_PREPROD_CONFIRM=athena-preproduction" >&2
  exit 2
fi
if [[ "${APP_ENV:-preproduction}" == "production" ]]; then
  echo "Refusing to run a preproduction drill with APP_ENV=production" >&2
  exit 2
fi

test -f "${secret_dir}/runtime.env"
mkdir -p "${evidence_dir}/backups"
chmod 700 "${evidence_dir}" "${evidence_dir}/backups"
set -a
# shellcheck disable=SC1090
source "${secret_dir}/runtime.env"
set +a
export ATHENA_PREPROD_SECRETS_DIR="${secret_dir}"

compose() {
  docker compose \
    --env-file "${secret_dir}/runtime.env" \
    "${compose_files[@]}" \
    --profile "*" \
    "$@"
}

cleanup() {
  compose exec -T postgresql \
    psql -X -qAt -U athena_platform_admin -d postgres \
    -c "DROP DATABASE IF EXISTS ${main_restore} WITH (FORCE);" \
    >/dev/null 2>&1 || true
  compose exec -T postgresql \
    psql -X -qAt -U athena_platform_admin -d postgres \
    -c "DROP DATABASE IF EXISTS ${auth_restore} WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

main_dump="${evidence_dir}/backups/main-${timestamp}.dump"
auth_dump="${evidence_dir}/backups/auth-${timestamp}.dump"
compose exec -T postgresql \
  pg_dump -U athena_platform_admin -d athena_main \
  --format=custom --no-owner --no-acl >"${main_dump}"
compose exec -T postgresql \
  pg_dump -U athena_platform_admin -d athena_auth \
  --format=custom --no-owner --no-acl >"${auth_dump}"
chmod 600 "${main_dump}" "${auth_dump}"

compose exec -T postgresql \
  psql -X -qAt -U athena_platform_admin -d postgres \
  -c "CREATE DATABASE ${main_restore};" >/dev/null
compose exec -T postgresql \
  psql -X -qAt -U athena_platform_admin -d postgres \
  -c "CREATE DATABASE ${auth_restore};" >/dev/null
compose exec -T postgresql \
  pg_restore -U athena_platform_admin -d "${main_restore}" \
  --exit-on-error --no-owner --no-acl <"${main_dump}"
compose exec -T postgresql \
  pg_restore -U athena_platform_admin -d "${auth_restore}" \
  --exit-on-error --no-owner --no-acl <"${auth_dump}"

table_counts() {
  local database="$1"
  compose exec -T postgresql \
    psql -X -qAt -F '|' -U athena_platform_admin -d "${database}" <<'SQL'
SELECT format(
  'SELECT %L, %L, count(*)::bigint FROM %I.%I;',
  schemaname,
  tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename
\gexec
SQL
}

main_source_counts="$(mktemp)"
main_restore_counts="$(mktemp)"
auth_source_counts="$(mktemp)"
auth_restore_counts="$(mktemp)"
trap 'rm -f "${main_source_counts}" "${main_restore_counts}" "${auth_source_counts}" "${auth_restore_counts}"; cleanup' EXIT

table_counts athena_main | LC_ALL=C sort >"${main_source_counts}"
table_counts "${main_restore}" | LC_ALL=C sort >"${main_restore_counts}"
table_counts athena_auth | LC_ALL=C sort >"${auth_source_counts}"
table_counts "${auth_restore}" | LC_ALL=C sort >"${auth_restore_counts}"

main_exact=false
auth_exact=false
if cmp -s "${main_source_counts}" "${main_restore_counts}"; then
  main_exact=true
fi
if cmp -s "${auth_source_counts}" "${auth_restore_counts}"; then
  auth_exact=true
fi

object_result="$(
  compose run --rm --no-deps --entrypoint /bin/sh minio-init -ec '
    set -eu
    source_bucket="athena-preproduction"
    restore_bucket="athena-preproduction-restore-'"${restore_suffix}"'"
    sentinel="athena/preproduction-backup-drill/'"${restore_suffix}"'.probe"
    cleanup() {
      mc rm --force "local/${source_bucket}/${sentinel}" --insecure >/dev/null 2>&1 || true
      mc rb --force "local/${restore_bucket}" --insecure >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    mc alias set local https://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" --insecure >/dev/null
    printf "athena-preproduction-backup-restore" | mc pipe "local/${source_bucket}/${sentinel}" --insecure >/dev/null
    mc mb --ignore-existing "local/${restore_bucket}" --insecure >/dev/null
    mc mirror --overwrite "local/${source_bucket}" "local/${restore_bucket}" --insecure >/dev/null
    source_count="$(mc find "local/${source_bucket}" --type f --insecure | wc -l | tr -d " ")"
    restore_count="$(mc find "local/${restore_bucket}" --type f --insecure | wc -l | tr -d " ")"
    diff_output="$(mc diff "local/${source_bucket}" "local/${restore_bucket}" --insecure || true)"
    if [ "${source_count}" = "${restore_count}" ] && [ -z "${diff_output}" ]; then
      printf "{\"exact\":true,\"sourceCount\":%s,\"restoreCount\":%s}\\n" "${source_count}" "${restore_count}"
    else
      printf "{\"exact\":false,\"sourceCount\":%s,\"restoreCount\":%s}\\n" "${source_count}" "${restore_count}"
      exit 1
    fi
  '
)"

object_exact="$(
  node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.exact===true))' \
    "${object_result}"
)"
source_object_count="$(
  node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.sourceCount||0))' \
    "${object_result}"
)"
restore_object_count="$(
  node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.restoreCount||0))' \
    "${object_result}"
)"

evidence="${evidence_dir}/backup-restore-${timestamp}.json"
MAIN_EXACT="${main_exact}" \
AUTH_EXACT="${auth_exact}" \
OBJECT_EXACT="${object_exact}" \
SOURCE_OBJECT_COUNT="${source_object_count}" \
RESTORE_OBJECT_COUNT="${restore_object_count}" \
MAIN_DUMP_NAME="$(basename "${main_dump}")" \
AUTH_DUMP_NAME="$(basename "${auth_dump}")" \
node - "${evidence}" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const target = process.argv[2];
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const directory = require("path").dirname(target);
const mainDump = require("path").join(
  directory,
  "backups",
  process.env.MAIN_DUMP_NAME
);
const authDump = require("path").join(
  directory,
  "backups",
  process.env.AUTH_DUMP_NAME
);
const mainDatabaseExact = process.env.MAIN_EXACT === "true";
const authDatabaseExact = process.env.AUTH_EXACT === "true";
const objectStoreExact = process.env.OBJECT_EXACT === "true";
const evidence = {
  version: "athena.preproduction-backup-restore-drill:v1",
  generatedAt: new Date().toISOString(),
  environment: "preproduction",
  passed: mainDatabaseExact && authDatabaseExact && objectStoreExact,
  mainDatabaseExact,
  authDatabaseExact,
  objectStoreExact,
  backups: {
    main: { file: process.env.MAIN_DUMP_NAME, sha256: digest(mainDump) },
    auth: { file: process.env.AUTH_DUMP_NAME, sha256: digest(authDump) },
  },
  objectCounts: {
    source: Number(process.env.SOURCE_OBJECT_COUNT || 0),
    restored: Number(process.env.RESTORE_OBJECT_COUNT || 0),
  },
  productionChanged: false,
  sensitiveValuesEmitted: false,
};
fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 2;
NODE

echo "Backup/restore evidence: ${evidence}"
