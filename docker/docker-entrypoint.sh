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

prepare_prisma_client() {
  if [ "${ATHENA_DATABASE_PROVIDER:-sqlite}" = "postgresql" ]; then
    test -f /app/server/generated/postgresql-main/index.js &&
      test -f /app/server/generated/postgresql-auth/index.js
    return
  fi
  node scripts/prisma-runtime.js generate
}

migrate_authoritative_databases() {
  if [ "${ATHENA_DATABASE_PROVIDER:-sqlite}" = "postgresql" ]; then
    node scripts/postgresql-prisma-runtime.js --execute --database main migrate deploy &&
      node scripts/postgresql-prisma-runtime.js --execute --database auth migrate deploy
    if [ "${ATHENA_MODULE_SCHEMA_CUTOVER:-false}" = "true" ]; then
      node scripts/provision-module-schema-ownership.js --database main --apply --execute &&
        node scripts/provision-module-schema-ownership.js --database auth --apply --execute
    fi
    return
  fi
  node scripts/prisma-runtime.js --execute migrate deploy &&
    node scripts/auth-prisma-runtime.js --execute migrate deploy
}

run_server() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    migrate_authoritative_databases &&
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
    prepare_prisma_client &&
    exec node /app/server/reader-worker.js
}

run_background_worker() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/background-worker.js
}

run_realtime_gateway() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/realtime-gateway.js
}

run_scheduler() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/scheduler.js
}

run_operations_plane() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/operations-plane.js
}

run_coordination_plane() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/coordination-plane.js
}

run_chat_runtime() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/chat-runtime.js
}

run_agent_runtime() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/agent-runtime.js
}

run_model_gateway() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/model-gateway.js
}

run_responses_runtime() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/responses-runtime.js
}

run_character_performance_runtime() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/character-performance-runtime.js
}

run_tool_broker() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/tool-broker.js
}

run_crypto_market() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    exec node /app/server/crypto-market.js
}

run_crypto_account() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/crypto-account.js
}

run_crypto_forecast() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/crypto-forecast.js
}

run_key_custody() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/key-custody.js
}

run_edge_probe() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    exec node /app/server/edge-probe.js
}

run_identity() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/identity.js
}

run_knowledge_ingest() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/knowledge-ingest.js
}

run_rag() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/rag.js
}

run_operations_shadow_agents() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/operations-shadow-agents.js
}

run_browser_plane() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/browser-plane.js
}

run_browser_worker() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    exec node /app/server/browser-worker.js
}

run_browser_egress() {
  cd /app/server/ &&
    verify_crypto_runtime &&
    export CHECKPOINT_DISABLE=1 &&
    prepare_prisma_client &&
    exec node /app/server/browser-egress.js
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
  scheduler)
    run_scheduler
    ;;
  operations-plane)
    run_operations_plane
    ;;
  coordination-plane)
    run_coordination_plane
    ;;
  chat-runtime)
    run_chat_runtime
    ;;
  agent-runtime)
    run_agent_runtime
    ;;
  model-gateway)
    run_model_gateway
    ;;
  responses-runtime)
    run_responses_runtime
    ;;
  character-performance-runtime)
    run_character_performance_runtime
    ;;
  tool-broker)
    run_tool_broker
    ;;
  crypto-market)
    run_crypto_market
    ;;
  crypto-account)
    run_crypto_account
    ;;
  crypto-forecast)
    run_crypto_forecast
    ;;
  key-custody)
    run_key_custody
    ;;
  edge-web)
    run_edge_probe
    ;;
  identity)
    run_identity
    ;;
  knowledge-ingest)
    run_knowledge_ingest
    ;;
  rag)
    run_rag
    ;;
  operations-shadow-agents)
    run_operations_shadow_agents
    ;;
  browser-plane)
    run_browser_plane
    ;;
  browser-worker)
    run_browser_worker
    ;;
  browser-egress)
    run_browser_egress
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
