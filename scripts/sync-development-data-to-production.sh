#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_BASE="${STORAGE_DIR:-$ROOT_DIR/server/storage}"
DEV_STORAGE="$STORAGE_BASE/development"
PROD_STORAGE="$STORAGE_BASE/production"
SHARED_STORAGE="$STORAGE_BASE/shared"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/anythingllm-data-sync-backups}"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"
CONFIRMED=0

log() {
  printf '[sync-development-data-to-production] %s\n' "$*"
}

usage() {
  cat <<EOF
Usage: bash ./scripts/sync-development-data-to-production.sh --yes

Copies development storage to production storage after creating backups.
This is a one-time explicit data sync. It does not create any automatic sync.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      CONFIRMED=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ "$CONFIRMED" != "1" ]]; then
  usage >&2
  log "refusing to sync without --yes"
  exit 1
fi

require_paths() {
  if [[ ! -d "$DEV_STORAGE" ]]; then
    log "development storage not found: $DEV_STORAGE"
    exit 1
  fi

  if [[ ! -d "$PROD_STORAGE" ]]; then
    log "production storage not found: $PROD_STORAGE"
    exit 1
  fi
}

port_pids() {
  local port="$1"
  lsof -ti tcp:"$port" 2>/dev/null || true
}

require_stopped() {
  local ports=(3000 3001 3002 8888 8889)
  local port
  local pids

  for port in "${ports[@]}"; do
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      log "refusing to sync while port $port is in use by PID(s): $(printf '%s' "$pids" | tr '\n' ' ')"
      log "run: bash ./stop-all"
      exit 1
    fi
  done
}

db_counts() {
  local label="$1"
  local db_path="$2"

  if [[ ! -f "$db_path" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
    printf '%s|db_missing_or_sqlite_unavailable\n' "$label"
    return 0
  fi

  sqlite3 "file:$db_path?immutable=1" \
    "select '$label', (select count(*) from workspaces), (select count(*) from workspace_threads), (select count(*) from workspace_chats), (select count(*) from workspace_documents), (select max(lastUpdatedAt) from workspace_chats);" \
    2>/dev/null || printf '%s|db_read_failed\n' "$label"
}

snapshot() {
  local label="$1"
  local storage_path="$2"

  log "$label storage: $storage_path"
  du -sh "$storage_path" 2>/dev/null || true
  db_counts "$label" "$storage_path/anythingllm.db"
}

backup_existing_data() {
  mkdir -p "$BACKUP_DIR"
  log "backup directory: $BACKUP_DIR"

  log "backing up production storage"
  rsync -a "$PROD_STORAGE/" "$BACKUP_DIR/production/"

  log "backing up development storage"
  rsync -a "$DEV_STORAGE/" "$BACKUP_DIR/development/"

  if [[ -d "$SHARED_STORAGE" ]]; then
    log "backing up shared auth storage"
    rsync -a "$SHARED_STORAGE/" "$BACKUP_DIR/shared/"
  fi

  if [[ -d "$ROOT_DIR/server/public" ]]; then
    log "backing up server/public"
    rsync -a "$ROOT_DIR/server/public/" "$BACKUP_DIR/server-public/"
  fi
}

sync_data() {
  log "syncing development storage to production storage"
  rsync -a --delete "$DEV_STORAGE/" "$PROD_STORAGE/"
}

require_paths
require_stopped

log "before sync"
snapshot production "$PROD_STORAGE"
snapshot development "$DEV_STORAGE"

backup_existing_data
sync_data

log "after sync"
snapshot production "$PROD_STORAGE"
snapshot development "$DEV_STORAGE"

log "done. Production storage now matches development storage. Backups remain at $BACKUP_DIR"
