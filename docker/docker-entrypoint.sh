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

run_server() {
  cd /app/server/ &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    node scripts/prisma-runtime.js migrate deploy &&
    node /app/server/index.js
}

run_collector() {
  node /app/collector/index.js
}

run_reader_worker() {
  cd /app/server/ &&
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    node /app/server/reader-worker.js
}

run_background_worker() {
  cd /app/server/ &&
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    node /app/server/background-worker.js
}

run_realtime_gateway() {
  cd /app/server/ &&
    export CHECKPOINT_DISABLE=1 &&
    node scripts/prisma-runtime.js generate &&
    node /app/server/realtime-gateway.js
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
    run_server &
    if [ "${ATHENA_COLLECTOR_INLINE:-true}" != "false" ]; then
      run_collector &
    fi
    wait -n
    exit $?
    ;;
esac
