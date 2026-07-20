#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.anythingllm-runtime"
LOG_DIR="$RUNTIME_DIR/logs"
APP_ENV=""
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
START_GRACE_SECONDS="${START_GRACE_SECONDS:-20}"
PORT_MISSING_GRACE_SECONDS="${PORT_MISSING_GRACE_SECONDS:-15}"
CRASH_WINDOW_SECONDS="${CRASH_WINDOW_SECONDS:-60}"
CRASH_LIMIT="${CRASH_LIMIT:-5}"
CRASH_COOLDOWN_SECONDS="${CRASH_COOLDOWN_SECONDS:-30}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-10485760}"
LOG_KEEP="${LOG_KEEP:-5}"
STOP_GRACE_SECONDS="${STOP_GRACE_SECONDS:-35}"
STOPPING=0
MOBILE_HTTPS="${MOBILE_HTTPS:-false}"
HTTPS_KEY_PATH="${HTTPS_KEY_PATH:-${VITE_HTTPS_KEY_PATH:-}}"
HTTPS_CERT_PATH="${HTTPS_CERT_PATH:-${VITE_HTTPS_CERT_PATH:-}}"
HTTPS_CA_CERT_PATH="${HTTPS_CA_CERT_PATH:-}"
HTTPS_PUBLIC_CA_PATH="${HTTPS_PUBLIC_CA_PATH:-}"
HTTPS_BACKEND_URL="${HTTPS_BACKEND_URL:-}"
VITE_DEV_API_PROXY_TARGET="${VITE_DEV_API_PROXY_TARGET:-}"

if ! [[ "$STOP_GRACE_SECONDS" =~ ^[0-9]+$ ]] || (( STOP_GRACE_SECONDS < 30 )); then
  STOP_GRACE_SECONDS=35
fi

mobile_https_enabled() {
  [[ "$MOBILE_HTTPS" == "1" || "$MOBILE_HTTPS" == "true" || "${VITE_DEV_HTTPS:-}" == "true" || "${ENABLE_HTTPS:-}" == "true" ]]
}

usage() {
  cat <<EOF
Usage: bash ./scripts/runtime-supervisor.sh --env development|production
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      APP_ENV="${2:-}"
      shift
      ;;
    --env=*)
      APP_ENV="${1#--env=}"
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

case "$APP_ENV" in
  development|production) ;;
  *)
    usage >&2
    exit 1
    ;;
esac

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

STATE_FILE="$RUNTIME_DIR/status-${APP_ENV}.env"
LOCK_DIR="$RUNTIME_DIR/supervisor-${APP_ENV}.lock"
SUPERVISOR_LOG="$LOG_DIR/${APP_ENV}-supervisor.log"
STORAGE_BASE="${STORAGE_DIR:-$ROOT_DIR/server/storage}"
ENV_STORAGE_ROOT="$STORAGE_BASE/$APP_ENV"

if [[ "$APP_ENV" == "development" ]]; then
  SERVER_PORT="${SERVER_PORT:-3002}"
  COLLECTOR_PORT="${COLLECTOR_PORT:-8889}"
  FRONTEND_PORT="${FRONTEND_PORT:-3000}"
  DEV_PUBLIC_HOST="${PUBLIC_DEV_HOST:-localhost}"
  if mobile_https_enabled; then
    APP_URL="${APP_URL:-https://${DEV_PUBLIC_HOST}:${FRONTEND_PORT}}"
    API_URL="${API_URL:-${MOBILE_HTTPS_API_BASE:-/api}}"
    HTTPS_BACKEND_URL="${HTTPS_BACKEND_URL:-https://localhost:${SERVER_PORT}}"
    VITE_DEV_API_PROXY_TARGET="${VITE_DEV_API_PROXY_TARGET:-$HTTPS_BACKEND_URL}"
  else
    APP_URL="${APP_URL:-http://${DEV_PUBLIC_HOST}:${FRONTEND_PORT}}"
    API_URL="${API_URL:-http://${DEV_PUBLIC_HOST}:${SERVER_PORT}/api}"
    HTTPS_BACKEND_URL=""
    VITE_DEV_API_PROXY_TARGET=""
  fi
  COMPONENTS="server collector frontend"
else
  SERVER_PORT="${SERVER_PORT:-3001}"
  COLLECTOR_PORT="${COLLECTOR_PORT:-8888}"
  FRONTEND_PORT=""
  if mobile_https_enabled; then
    APP_URL="https://localhost:${SERVER_PORT}"
    API_URL="https://localhost:${SERVER_PORT}/api"
  else
    APP_URL="http://localhost:${SERVER_PORT}"
    API_URL="http://localhost:${SERVER_PORT}/api"
  fi
  COMPONENTS="server collector"
fi

now_epoch() {
  date +%s
}

now_human() {
  date '+%Y-%m-%d %H:%M:%S'
}

file_size() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf '0'
    return
  fi
  stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || wc -c <"$file" | tr -d ' '
}

rotate_log() {
  local file="$1"
  local size
  local i
  local prev

  mkdir -p "$(dirname "$file")"
  [[ -f "$file" ]] || : >"$file"
  size="$(file_size "$file")"
  if [[ -z "$size" ]] || (( size <= LOG_MAX_BYTES )); then
    return 0
  fi

  rm -f "${file}.${LOG_KEEP}"
  i=$((LOG_KEEP - 1))
  while (( i >= 1 )); do
    prev="${file}.${i}"
    if [[ -f "$prev" ]]; then
      mv "$prev" "${file}.$((i + 1))"
    fi
    i=$((i - 1))
  done
  mv "$file" "${file}.1"
  : >"$file"
}

log() {
  rotate_log "$SUPERVISOR_LOG"
  printf '[%s] [supervisor:%s] %s\n' "$(now_human)" "$APP_ENV" "$*" >>"$SUPERVISOR_LOG"
}

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

pid_environment_command() {
  local pid="$1"
  ps eww -p "$pid" -o command= 2>/dev/null || pid_command "$pid"
}

frontend_listener_matches_mobile_https() {
  local pid="$1"
  local command
  command="$(pid_environment_command "$pid")"
  [[ "$command" == *"VITE_DEV_HTTPS=true"* &&
    "$command" == *"VITE_DEV_API_PROXY_TARGET=${VITE_DEV_API_PROXY_TARGET}"* &&
    "$command" == *"VITE_HTTPS_KEY_PATH=${HTTPS_KEY_PATH}"* &&
    "$command" == *"VITE_HTTPS_CERT_PATH=${HTTPS_CERT_PATH}"* ]]
}

pid_cwd_under_root() {
  local pid="$1"
  local cwd
  cwd="$(pid_cwd "$pid")"
  [[ "$cwd" == "$ROOT_DIR"* ]]
}

kill_pid() {
  local pid="${1:-}"
  local name="${2:-process}"
  local deadline

  if ! pid_alive "$pid"; then return 0; fi
  log "stopping $name pid=$pid"
  kill "$pid" >/dev/null 2>&1 || true
  deadline=$(( $(now_epoch) + STOP_GRACE_SECONDS ))
  while (( $(now_epoch) < deadline )); do
    if ! pid_alive "$pid"; then return 0; fi
    sleep 0.25
  done
  log "force stopping $name pid=$pid"
  kill -9 "$pid" >/dev/null 2>&1 || true
}

kill_pid_tree() {
  local pid="${1:-}"
  local name="${2:-process}"
  local children
  local child

  if ! pid_alive "$pid"; then return 0; fi
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    kill_pid_tree "$child" "$name child"
  done
  kill_pid "$pid" "$name"
}

read_lock_pid() {
  cat "$LOCK_DIR/pid" 2>/dev/null || true
}

acquire_lock() {
  local existing_pid

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    printf '%s\n' "$APP_ENV" >"$LOCK_DIR/env"
    now_human >"$LOCK_DIR/startedAt"
    return 0
  fi

  existing_pid="$(read_lock_pid)"
  if pid_alive "$existing_pid"; then
    log "another supervisor is already running pid=$existing_pid"
    exit 0
  fi

  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    printf '%s\n' "$APP_ENV" >"$LOCK_DIR/env"
    now_human >"$LOCK_DIR/startedAt"
    return 0
  fi

  log "failed to acquire supervisor lock"
  exit 1
}

cleanup_lock() {
  local locked_pid
  locked_pid="$(read_lock_pid)"
  if [[ "$locked_pid" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  fi
}

component_upper() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
}

state_var_name() {
  printf '%s_%s' "$(component_upper "$1")" "$2"
}

set_component_var() {
  local component="$1"
  local field="$2"
  local value="${3:-}"
  local var
  var="$(state_var_name "$component" "$field")"
  printf -v "$var" '%s' "$value"
}

get_component_var() {
  local component="$1"
  local field="$2"
  local var
  var="$(state_var_name "$component" "$field")"
  printf '%s' "${!var:-}"
}

component_port() {
  case "$1" in
    server) printf '%s' "$SERVER_PORT" ;;
    collector) printf '%s' "$COLLECTOR_PORT" ;;
    frontend) printf '%s' "$FRONTEND_PORT" ;;
  esac
}

component_dir() {
  case "$1" in
    server) printf '%s/server' "$ROOT_DIR" ;;
    collector) printf '%s/collector' "$ROOT_DIR" ;;
    frontend) printf '%s/frontend' "$ROOT_DIR" ;;
  esac
}

component_log() {
  printf '%s/%s-%s.log' "$LOG_DIR" "$APP_ENV" "$1"
}

listener_pids_for_port() {
  local port="${1:-}"
  [[ -z "$port" ]] && return 0
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

external_listener_pids() {
  local port="$1"
  local pid
  listener_pids_for_port "$port" | while read -r pid; do
    [[ -z "$pid" ]] && continue
    if ! pid_cwd_under_root "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

repo_listener_pids() {
  local port="$1"
  local pid
  listener_pids_for_port "$port" | while read -r pid; do
    [[ -z "$pid" ]] && continue
    if pid_cwd_under_root "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

first_line() {
  sed -n '1p'
}

count_words() {
  wc -w | tr -d ' '
}

seconds_since() {
  local started="${1:-0}"
  local now
  now="$(now_epoch)"
  if [[ -z "$started" ]] || (( started <= 0 )); then
    printf '0'
  else
    printf '%s' "$((now - started))"
  fi
}

init_component_state() {
  local component
  for component in $COMPONENTS; do
    set_component_var "$component" STATUS "stopped"
    set_component_var "$component" PID ""
    set_component_var "$component" STARTED_EPOCH "0"
    set_component_var "$component" UPTIME_SECONDS "0"
    set_component_var "$component" RESTART_COUNT "0"
    set_component_var "$component" RESTART_TIMES ""
    set_component_var "$component" LAST_RESTART_REASON "initial-start"
    set_component_var "$component" CRASH_LOOP "false"
    set_component_var "$component" COOLDOWN_UNTIL "0"
    set_component_var "$component" PORT_MISSING_SINCE "0"
  done
}

mark_component_degraded() {
  local component="$1"
  local reason="$2"
  set_component_var "$component" STATUS "degraded"
  set_component_var "$component" LAST_RESTART_REASON "$reason"
  set_component_var "$component" UPTIME_SECONDS "0"
}

record_restart_window() {
  local component="$1"
  local now="$2"
  local existing
  local kept=""
  local item
  local count

  existing="$(get_component_var "$component" RESTART_TIMES)"
  for item in $existing; do
    if (( now - item < CRASH_WINDOW_SECONDS )); then
      kept="$kept $item"
    fi
  done

  count="$(printf '%s\n' "$kept" | count_words)"
  if (( count >= CRASH_LIMIT )); then
    set_component_var "$component" RESTART_TIMES "$kept"
    set_component_var "$component" CRASH_LOOP "true"
    set_component_var "$component" COOLDOWN_UNTIL "$((now + CRASH_COOLDOWN_SECONDS))"
    mark_component_degraded "$component" "crash-loop-cooldown"
    log "$component entered crash-loop cooldown after $count restarts in ${CRASH_WINDOW_SECONDS}s"
    return 1
  fi

  kept="$kept $now"
  set_component_var "$component" RESTART_TIMES "$kept"
  set_component_var "$component" CRASH_LOOP "false"
  return 0
}

increment_restart_count() {
  local component="$1"
  local current
  current="$(get_component_var "$component" RESTART_COUNT)"
  current="${current:-0}"
  set_component_var "$component" RESTART_COUNT "$((current + 1))"
}

adopt_component() {
  local component="$1"
  local pid="$2"
  local reason="${3:-adopted-repo-listener}"
  local now

  now="$(now_epoch)"
  set_component_var "$component" PID "$pid"
  set_component_var "$component" STARTED_EPOCH "$now"
  set_component_var "$component" UPTIME_SECONDS "0"
  set_component_var "$component" STATUS "running"
  set_component_var "$component" LAST_RESTART_REASON "$reason"
  set_component_var "$component" CRASH_LOOP "false"
  log "$component adopted repo listener pid=$pid reason=$reason"
}

start_component_process() {
  local component="$1"
  local logfile
  local pid=""
  local enable_https=""

  if mobile_https_enabled; then
    enable_https="true"
  fi

  logfile="$(component_log "$component")"
  rotate_log "$logfile"

  case "$APP_ENV:$component" in
    development:server)
      (
        cd "$ROOT_DIR/server" || exit 1
        nohup env \
          APP_ENV=development \
          NODE_ENV=development \
          SERVER_PORT="$SERVER_PORT" \
          COLLECTOR_PORT="$COLLECTOR_PORT" \
          ENABLE_HTTPS="$enable_https" \
          HTTPS_KEY_PATH="$HTTPS_KEY_PATH" \
          HTTPS_CERT_PATH="$HTTPS_CERT_PATH" \
          ANYTHINGLLM_STORAGE_BASE_DIR="$STORAGE_BASE" \
          ANYTHINGLLM_ENV_STORAGE_APPLIED=true \
          STORAGE_DIR="$ENV_STORAGE_ROOT" \
          ./node_modules/.bin/nodemon \
            --ignore documents \
            --ignore vector-cache \
            --ignore storage \
            --ignore swagger \
            --no-stdin \
            --trace-warnings index.js \
          </dev/null >>"$logfile" 2>&1 &
        echo $!
      )
      ;;
    development:collector)
      (
        cd "$ROOT_DIR/collector" || exit 1
        nohup env \
          APP_ENV=development \
          NODE_ENV=development \
          SERVER_PORT="$SERVER_PORT" \
          COLLECTOR_PORT="$COLLECTOR_PORT" \
          ENABLE_HTTPS="$enable_https" \
          HTTPS_KEY_PATH="$HTTPS_KEY_PATH" \
          HTTPS_CERT_PATH="$HTTPS_CERT_PATH" \
          ANYTHINGLLM_STORAGE_BASE_DIR="$STORAGE_BASE" \
          ANYTHINGLLM_ENV_STORAGE_APPLIED=true \
          STORAGE_DIR="$ENV_STORAGE_ROOT" \
          ./node_modules/.bin/nodemon \
            --ignore hotdir \
            --ignore storage \
            --no-stdin \
            --trace-warnings index.js \
          </dev/null >>"$logfile" 2>&1 &
        echo $!
      )
      ;;
    development:frontend)
      (
        cd "$ROOT_DIR/frontend" || exit 1
        if mobile_https_enabled; then
          nohup env \
            APP_ENV=development \
            NODE_ENV=development \
            SERVER_PORT="$SERVER_PORT" \
            COLLECTOR_PORT="$COLLECTOR_PORT" \
            ANYTHINGLLM_STORAGE_BASE_DIR="$STORAGE_BASE" \
            ANYTHINGLLM_ENV_STORAGE_APPLIED=true \
            STORAGE_DIR="$ENV_STORAGE_ROOT" \
            VITE_API_BASE="$API_URL" \
            VITE_DEV_HTTPS=true \
            VITE_HTTPS_KEY_PATH="$HTTPS_KEY_PATH" \
            VITE_HTTPS_CERT_PATH="$HTTPS_CERT_PATH" \
            VITE_DEV_API_PROXY_TARGET="$VITE_DEV_API_PROXY_TARGET" \
            ./node_modules/.bin/vite \
              --debug \
              --host 0.0.0.0 \
              --port "$FRONTEND_PORT" \
              --strictPort \
            </dev/null >>"$logfile" 2>&1 &
        else
          nohup env \
            APP_ENV=development \
            NODE_ENV=development \
            SERVER_PORT="$SERVER_PORT" \
            COLLECTOR_PORT="$COLLECTOR_PORT" \
            ANYTHINGLLM_STORAGE_BASE_DIR="$STORAGE_BASE" \
            ANYTHINGLLM_ENV_STORAGE_APPLIED=true \
            STORAGE_DIR="$ENV_STORAGE_ROOT" \
            VITE_API_BASE="$API_URL" \
            ./node_modules/.bin/vite \
              --debug \
              --host 0.0.0.0 \
              --port "$FRONTEND_PORT" \
              --strictPort \
            </dev/null >>"$logfile" 2>&1 &
        fi
        echo $!
      )
      ;;
    production:server)
      (
        cd "$ROOT_DIR/server" || exit 1
        nohup env \
          APP_ENV=production \
          NODE_ENV=production \
          SERVER_PORT="$SERVER_PORT" \
          COLLECTOR_PORT="$COLLECTOR_PORT" \
          ANYTHINGLLM_STORAGE_BASE_DIR="$STORAGE_BASE" \
          ANYTHINGLLM_ENV_STORAGE_APPLIED=true \
          STORAGE_DIR="$ENV_STORAGE_ROOT" \
          yarn start \
          </dev/null >>"$logfile" 2>&1 &
        echo $!
      )
      ;;
    production:collector)
      (
        cd "$ROOT_DIR/collector" || exit 1
        nohup env \
          APP_ENV=production \
          NODE_ENV=production \
          SERVER_PORT="$SERVER_PORT" \
          COLLECTOR_PORT="$COLLECTOR_PORT" \
          ANYTHINGLLM_STORAGE_BASE_DIR="$STORAGE_BASE" \
          ANYTHINGLLM_ENV_STORAGE_APPLIED=true \
          STORAGE_DIR="$ENV_STORAGE_ROOT" \
          yarn start \
          </dev/null >>"$logfile" 2>&1 &
        echo $!
      )
      ;;
  esac
}

start_component() {
  local component="$1"
  local reason="${2:-manual-restart}"
  local port
  local external_pids
  local repo_pids
  local pid
  local now
  local cooldown_until

  port="$(component_port "$component")"
  now="$(now_epoch)"
  cooldown_until="$(get_component_var "$component" COOLDOWN_UNTIL)"
  cooldown_until="${cooldown_until:-0}"

  if (( cooldown_until > now )); then
    mark_component_degraded "$component" "crash-loop-cooldown"
    set_component_var "$component" CRASH_LOOP "true"
    return 0
  fi

  external_pids="$(external_listener_pids "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -n "$external_pids" ]]; then
    set_component_var "$component" PID ""
    set_component_var "$component" CRASH_LOOP "false"
    mark_component_degraded "$component" "external-port-owner:${external_pids}"
    log "$component degraded because port $port is owned by external pid(s): $external_pids"
    return 0
  fi

  repo_pids="$(repo_listener_pids "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ "$APP_ENV:$component" == "development:frontend" && -n "$repo_pids" ]] && mobile_https_enabled; then
    local compatible_repo_pids=""
    local repo_pid
    for repo_pid in $repo_pids; do
      if frontend_listener_matches_mobile_https "$repo_pid"; then
        compatible_repo_pids="$compatible_repo_pids $repo_pid"
      else
        log "frontend repo listener pid=$repo_pid is not mobile HTTPS compatible; restarting it"
        kill_pid_tree "$repo_pid" "frontend incompatible listener"
      fi
    done
    repo_pids="$(printf '%s\n' "$compatible_repo_pids" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  fi
  if [[ -n "$repo_pids" ]]; then
    pid="$(printf '%s\n' "$repo_pids" | awk '{print $1}')"
    adopt_component "$component" "$pid" "adopted-repo-listener"
    return 0
  fi

  if ! record_restart_window "$component" "$now"; then
    return 0
  fi

  log "starting $component reason=$reason port=$port"
  pid="$(start_component_process "$component" | tail -1)"
  if [[ -z "$pid" ]]; then
    mark_component_degraded "$component" "start-command-failed"
    return 0
  fi

  increment_restart_count "$component"
  set_component_var "$component" PID "$pid"
  set_component_var "$component" STARTED_EPOCH "$now"
  set_component_var "$component" UPTIME_SECONDS "0"
  set_component_var "$component" STATUS "starting"
  set_component_var "$component" LAST_RESTART_REASON "$reason"
  set_component_var "$component" CRASH_LOOP "false"
  set_component_var "$component" PORT_MISSING_SINCE "0"
}

check_component() {
  local component="$1"
  local pid
  local port
  local external_pids
  local repo_pids
  local started
  local uptime
  local status

  pid="$(get_component_var "$component" PID)"
  port="$(component_port "$component")"
  external_pids="$(external_listener_pids "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -n "$external_pids" ]]; then
    if [[ -n "$pid" ]] && pid_alive "$pid"; then
      kill_pid_tree "$pid" "$component"
    fi
    set_component_var "$component" PID ""
    set_component_var "$component" PORT_MISSING_SINCE "0"
    mark_component_degraded "$component" "external-port-owner:${external_pids}"
    return 0
  fi

  repo_pids="$(repo_listener_pids "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ "$APP_ENV:$component" == "development:frontend" && -n "$repo_pids" ]] && mobile_https_enabled; then
    local compatible_repo_pids=""
    local repo_pid
    for repo_pid in $repo_pids; do
      if frontend_listener_matches_mobile_https "$repo_pid"; then
        compatible_repo_pids="$compatible_repo_pids $repo_pid"
      else
        log "frontend repo listener pid=$repo_pid is not mobile HTTPS compatible during health check; restarting it"
        kill_pid_tree "$repo_pid" "frontend incompatible listener"
      fi
    done
    repo_pids="$(printf '%s\n' "$compatible_repo_pids" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  fi
  if [[ -n "$repo_pids" ]]; then
    if [[ -z "$pid" ]] || ! pid_alive "$pid"; then
      adopt_component "$component" "$(printf '%s\n' "$repo_pids" | awk '{print $1}')" "adopted-repo-listener"
    fi
    started="$(get_component_var "$component" STARTED_EPOCH)"
    uptime="$(seconds_since "${started:-0}")"
    set_component_var "$component" UPTIME_SECONDS "$uptime"
    set_component_var "$component" STATUS "running"
    set_component_var "$component" PORT_MISSING_SINCE "0"
    if (( uptime > CRASH_WINDOW_SECONDS )); then
      set_component_var "$component" CRASH_LOOP "false"
      set_component_var "$component" RESTART_TIMES ""
      set_component_var "$component" COOLDOWN_UNTIL "0"
    fi
    return 0
  fi

  if [[ -n "$pid" ]] && pid_alive "$pid"; then
    local missing_since
    local missing_for
    local now
    started="$(get_component_var "$component" STARTED_EPOCH)"
    uptime="$(seconds_since "${started:-0}")"
    status="$(get_component_var "$component" STATUS)"
    if [[ "$status" == "starting" ]] && (( uptime < START_GRACE_SECONDS )); then
      set_component_var "$component" UPTIME_SECONDS "$uptime"
      return 0
    fi
    now="$(now_epoch)"
    missing_since="$(get_component_var "$component" PORT_MISSING_SINCE)"
    missing_since="${missing_since:-0}"
    if (( missing_since <= 0 )); then
      set_component_var "$component" PORT_MISSING_SINCE "$now"
      set_component_var "$component" STATUS "recovering"
      set_component_var "$component" UPTIME_SECONDS "$uptime"
      log "$component pid=$pid is alive but port $port is missing; waiting up to ${PORT_MISSING_GRACE_SECONDS}s for transient recovery"
      return 0
    fi
    missing_for=$((now - missing_since))
    if (( missing_for < PORT_MISSING_GRACE_SECONDS )); then
      set_component_var "$component" STATUS "recovering"
      set_component_var "$component" UPTIME_SECONDS "$uptime"
      return 0
    fi
    log "$component pid=$pid is alive but port $port is missing; restarting"
    kill_pid_tree "$pid" "$component"
    set_component_var "$component" PID ""
    set_component_var "$component" PORT_MISSING_SINCE "0"
    start_component "$component" "port-missing"
    return 0
  fi

  set_component_var "$component" PID ""
  set_component_var "$component" PORT_MISSING_SINCE "0"
  start_component "$component" "pid-exited"
}

write_kv() {
  local file="$1"
  local key="$2"
  local value="${3:-}"
  printf '%s=%q\n' "$key" "$value" >>"$file"
}

write_state() {
  local tmp
  local component
  local upper
  local port
  local logfile
  local supervisor_uptime

  tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
  supervisor_uptime="$(seconds_since "$SUPERVISOR_STARTED_EPOCH")"

  write_kv "$tmp" APP_ENV "$APP_ENV"
  write_kv "$tmp" SUPERVISOR_PID "$$"
  write_kv "$tmp" SUPERVISOR_LOG "$SUPERVISOR_LOG"
  write_kv "$tmp" SUPERVISOR_STARTED_AT "$SUPERVISOR_STARTED_AT"
  write_kv "$tmp" SUPERVISOR_UPTIME_SECONDS "$supervisor_uptime"
  write_kv "$tmp" LAST_CHECK_AT "$(now_human)"
  write_kv "$tmp" SERVER_PORT "$SERVER_PORT"
  write_kv "$tmp" COLLECTOR_PORT "$COLLECTOR_PORT"
  write_kv "$tmp" FRONTEND_PORT "$FRONTEND_PORT"
  write_kv "$tmp" APP_URL "$APP_URL"
  write_kv "$tmp" API_URL "$API_URL"
  if mobile_https_enabled; then
    write_kv "$tmp" HTTPS_ENABLED "true"
  else
    write_kv "$tmp" HTTPS_ENABLED "false"
  fi
  write_kv "$tmp" HTTPS_KEY_PATH "$HTTPS_KEY_PATH"
  write_kv "$tmp" HTTPS_CERT_PATH "$HTTPS_CERT_PATH"
  write_kv "$tmp" HTTPS_CA_CERT_PATH "$HTTPS_CA_CERT_PATH"
  write_kv "$tmp" HTTPS_PUBLIC_CA_PATH "$HTTPS_PUBLIC_CA_PATH"
  write_kv "$tmp" HTTPS_BACKEND_URL "$HTTPS_BACKEND_URL"
  write_kv "$tmp" STARTED_AT "$SUPERVISOR_STARTED_AT"

  for component in server collector frontend; do
    upper="$(component_upper "$component")"
    port=""
    logfile=""
    case "$component" in
      server) port="$SERVER_PORT" ;;
      collector) port="$COLLECTOR_PORT" ;;
      frontend) port="$FRONTEND_PORT" ;;
    esac
    if [[ "$component" == "frontend" && "$APP_ENV" == "production" ]]; then
      write_kv "$tmp" "${upper}_PID" ""
      write_kv "$tmp" "${upper}_LOG" ""
      write_kv "$tmp" "${upper}_STATUS" "disabled"
      write_kv "$tmp" "${upper}_UPTIME_SECONDS" "0"
      write_kv "$tmp" "${upper}_LAST_RESTART_REASON" "production-static-server"
      write_kv "$tmp" "${upper}_CRASH_LOOP" "false"
      write_kv "$tmp" "${upper}_RESTART_COUNT" "0"
      continue
    fi

    logfile="$(component_log "$component")"
    write_kv "$tmp" "${upper}_PID" "$(get_component_var "$component" PID)"
    write_kv "$tmp" "${upper}_LOG" "$logfile"
    write_kv "$tmp" "${upper}_STATUS" "$(get_component_var "$component" STATUS)"
    write_kv "$tmp" "${upper}_UPTIME_SECONDS" "$(get_component_var "$component" UPTIME_SECONDS)"
    write_kv "$tmp" "${upper}_LAST_RESTART_REASON" "$(get_component_var "$component" LAST_RESTART_REASON)"
    write_kv "$tmp" "${upper}_CRASH_LOOP" "$(get_component_var "$component" CRASH_LOOP)"
    write_kv "$tmp" "${upper}_RESTART_COUNT" "$(get_component_var "$component" RESTART_COUNT)"
    write_kv "$tmp" "${upper}_PORT" "$port"
  done

  mv "$tmp" "$STATE_FILE"
}

stop_all_components() {
  local component
  local pid
  for component in $COMPONENTS; do
    pid="$(get_component_var "$component" PID)"
    if [[ -n "$pid" ]]; then
      kill_pid_tree "$pid" "$component"
    fi
  done
}

handle_stop() {
  STOPPING=1
  log "stopping supervisor"
  stop_all_components
  cleanup_lock
  write_state
  exit 0
}

trap handle_stop TERM INT
trap '' HUP
trap cleanup_lock EXIT

SUPERVISOR_STARTED_EPOCH="$(now_epoch)"
SUPERVISOR_STARTED_AT="$(now_human)"

if [[ "$APP_ENV" == "development" ]] && mobile_https_enabled; then
  if [[ ! -f "$HTTPS_KEY_PATH" || ! -f "$HTTPS_CERT_PATH" ]]; then
    log "error: HTTPS dev mode requires HTTPS_KEY_PATH and HTTPS_CERT_PATH to point at existing files"
    exit 1
  fi
fi

acquire_lock
init_component_state
log "started supervisor pid=$$"

for component in $COMPONENTS; do
  start_component "$component" "initial-start"
done
write_state

while [[ "$STOPPING" != "1" ]]; do
  for component in $COMPONENTS; do
    check_component "$component"
  done
  write_state
  sleep "$CHECK_INTERVAL" &
  wait $! || true
done
