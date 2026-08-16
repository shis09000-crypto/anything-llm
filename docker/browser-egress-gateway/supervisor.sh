#!/bin/sh
set -eu

config_dir="${ATHENA_BROWSER_EGRESS_CONFIG_DIR:-/config}"
desired="${config_dir}/desired.json"
active="${config_dir}/active.json"
status="${config_dir}/status.json"
probe="${config_dir}/probe.json"
probe_port="${ATHENA_BROWSER_EGRESS_PROBE_PORT:-18443}"
child=""
active_sha=""

write_status() {
  ready="$1"
  reason="$2"
  sha="$3"
  tmp="${status}.$$"
  jq -nc \
    --argjson ready "$ready" \
    --arg reasonCode "$reason" \
    --arg configSha256 "$sha" \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{ready:$ready,reasonCode:(if ($reasonCode|length)>0 then $reasonCode else null end),configSha256:(if ($configSha256|length)>0 then $configSha256 else null end),checkedAt:$checkedAt,latencyMs:0}' \
    >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$status"
}

stop_child() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  child=""
}

cleanup() {
  stop_child
  rm -f "$probe"
}
trap cleanup TERM INT EXIT

mkdir -p "$config_dir"
chmod 0700 "$config_dir"
write_status false "gateway_waiting_for_config" ""

while :; do
  if [ ! -s "$desired" ]; then
    sleep 1
    continue
  fi
  candidate_sha="$(sha256sum "$desired" | awk '{print $1}')"
  if [ "$candidate_sha" = "$active_sha" ]; then
    if [ -z "$child" ] || ! kill -0 "$child" 2>/dev/null; then
      write_status false "gateway_process_exited" "$active_sha"
      active_sha=""
    fi
    sleep 1
    continue
  fi
  if ! sing-box check -c "$desired" >/dev/null 2>&1; then
    write_status false "gateway_candidate_rejected" "$candidate_sha"
    sleep 2
    continue
  fi
  jq --argjson port "$probe_port" '.inbounds[0].listen="127.0.0.1" | .inbounds[0].listen_port=$port' "$desired" >"$probe"
  chmod 0600 "$probe"
  sing-box run -c "$probe" >/dev/null 2>&1 &
  probe_child="$!"
  probe_ok=false
  index=0
  while [ "$index" -lt 30 ]; do
    if ! kill -0 "$probe_child" 2>/dev/null; then break; fi
    if curl --silent --connect-timeout 1 "telnet://127.0.0.1:${probe_port}" >/dev/null 2>&1; then
      probe_ok=true
      break
    fi
    index=$((index + 1))
    sleep 0.1
  done
  kill -TERM "$probe_child" 2>/dev/null || true
  wait "$probe_child" 2>/dev/null || true
  rm -f "$probe"
  if [ "$probe_ok" != true ]; then
    write_status false "gateway_isolated_probe_failed" "$candidate_sha"
    sleep 2
    continue
  fi
  cp "$desired" "${active}.candidate"
  chmod 0600 "${active}.candidate"
  mv -f "${active}.candidate" "$active"
  stop_child
  sing-box run -c "$active" >/dev/null 2>&1 &
  child="$!"
  sleep 1
  if ! kill -0 "$child" 2>/dev/null; then
    write_status false "gateway_activation_failed" "$candidate_sha"
    active_sha=""
    continue
  fi
  active_sha="$candidate_sha"
  write_status true "" "$active_sha"
done
