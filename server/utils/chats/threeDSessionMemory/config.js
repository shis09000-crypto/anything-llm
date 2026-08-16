function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function memoryConfig(env = process.env) {
  const defaultEnabled = env.NODE_ENV === "test" ? "false" : "true";
  return {
    enabled: String(env.ATHENA_3D_MEMORY_ENABLED ?? defaultEnabled) === "true",
    contextBudgetTokens: positiveInteger(
      env.ATHENA_3D_MEMORY_CONTEXT_BUDGET_TOKENS,
      950_000
    ),
    compressionTriggerTokens: positiveInteger(
      env.ATHENA_3D_MEMORY_COMPRESSION_TRIGGER_TOKENS,
      850_000
    ),
    hardGateTokens: positiveInteger(
      env.ATHENA_3D_MEMORY_HARD_GATE_TOKENS,
      920_000
    ),
    compressionTriggerTurns: positiveInteger(
      env.ATHENA_3D_MEMORY_COMPRESSION_TRIGGER_TURNS,
      512
    ),
    checkpointMaxTokens: positiveInteger(
      env.ATHENA_3D_MEMORY_CHECKPOINT_MAX_TOKENS,
      24_000
    ),
    stateWindowMaxTokens: positiveInteger(
      env.ATHENA_3D_MEMORY_STATE_WINDOW_MAX_TOKENS,
      128_000
    ),
    jobLeaseMs: positiveInteger(env.ATHENA_3D_MEMORY_JOB_LEASE_MS, 120_000),
    jobMaxAttempts: positiveInteger(env.ATHENA_3D_MEMORY_JOB_MAX_ATTEMPTS, 5),
    longTermJobMaxAttempts: positiveInteger(
      env.ATHENA_3D_LONG_TERM_MEMORY_JOB_MAX_ATTEMPTS,
      3
    ),
    longTermContextMaxTokens: positiveInteger(
      env.ATHENA_3D_LONG_TERM_MEMORY_CONTEXT_MAX_TOKENS,
      32_000
    ),
    maintenanceIntervalMs: positiveInteger(
      env.ATHENA_3D_MEMORY_MAINTENANCE_INTERVAL_MS,
      5_000
    ),
    contextCacheTtlMs: positiveInteger(
      env.ATHENA_3D_CONTEXT_CACHE_TTL_MS,
      900_000
    ),
  };
}

module.exports = { memoryConfig, positiveInteger };
