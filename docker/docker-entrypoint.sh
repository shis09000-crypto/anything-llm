#!/bin/bash

# Check if STORAGE_DIR is set
if [ -z "$STORAGE_DIR" ]; then
    echo "================================================================"
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo ""
    echo "Not setting this will result in data loss on container restart since"
    echo "the application will not have a persistent storage location."
    echo "It can also result in weird errors in various parts of the application."
    echo ""
    echo "Please run the container with the official docker command at"
    echo "https://docs.anythingllm.com/installation-docker/quickstart"
    echo ""
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo "================================================================"
fi

verify_crypto_runtime() {
  if [ "${ATHENA_REQUIRE_NODE24_PQ_PROBE:-false}" = "true" ]; then
    node /app/server/scripts/verify-crypto-runtime-capabilities.js \
      --require-node24-pq
  fi
}

run_server() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    node scripts/prisma-runtime.js --execute migrate deploy &&
    node scripts/auth-prisma-runtime.js --execute migrate deploy &&
    node scripts/verify-runtime-prisma-contract.js &&
    exec node /app/server/index.js
}

run_collector() {
  exec node /app/collector/index.js
}

run_reader_worker() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    exec node /app/server/reader-worker.js
}

run_background_worker() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    exec node /app/server/background-worker.js
}

run_realtime_gateway() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    exec node /app/server/realtime-gateway.js
}

child_pids=()

stop_children() {
  trap - TERM INT
  for pid in "${child_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${child_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

case "${ATHENA_RUNTIME_ROLE:-monolith}" in
  api)
    run_server
    ;;
  background-worker)
    run_background_worker
    ;;
  collector)
    run_collector
    ;;
  realtime-gateway)
    run_realtime_gateway
    ;;
  reader-worker)
    run_reader_worker
    ;;
  monolith|*)
    trap stop_children TERM INT
    run_server &
    child_pids+=("$!")
    if [ "${ATHENA_COLLECTOR_INLINE:-true}" != "false" ]; then
      run_collector &
      child_pids+=("$!")
    fi
    wait -n
    status=$?
    stop_children
    exit "$status"
    ;;
esac
