/* eslint-env jest */

const {
  EVIDENCE_VERSION,
  evaluateCutover,
} = require("../../scripts/verify-micro-module-cutover");

function distributedEnv() {
  return {
    ATHENA_RUNTIME_TOPOLOGY: "distributed",
    ATHENA_DATABASE_PROVIDER: "postgresql",
    ATHENA_POSTGRES_MAIN_URL: "postgresql://main@db/athena_main",
    ATHENA_POSTGRES_AUTH_URL: "postgresql://auth@db/athena_auth",
    ATHENA_BROADCAST_TRANSPORT: "nats",
    ATHENA_NATS_SERVERS: "tls://nats:4222",
    ATHENA_CONTENT_STORE: "s3",
    ATHENA_S3_BUCKET: "athena",
    ATHENA_SERVICE_MTLS_REQUIRED: "true",
    ATHENA_READER_WORKER_QUEUE: "true",
    ATHENA_READER_WORKER_FALLBACK_IN_PROCESS: "false",
    ATHENA_MODULE_SCHEMA_CUTOVER: "true",
    ATHENA_SHARED_STORAGE_CUTOVER: "true",
    ATHENA_KEY_CUSTODY_URL: "https://key-custody:3023",
    ATHENA_KEY_CUSTODY_CUTOVER: "true",
    ATHENA_LEGACY_RUNTIME_WRITE_ENABLED: "false",
    ATHENA_SQLITE_RUNTIME_FALLBACK: "false",
    ATHENA_MEMORY_TRANSPORT_FALLBACK: "false",
    ATHENA_MONOLITH_RUNTIME_MODE: "read-only",
  };
}

function evidence() {
  return {
    version: EVIDENCE_VERSION,
    databases: {
      main: {
        snapshotComplete: true,
        caughtUp: true,
        valid: true,
        mismatchCount: 0,
      },
      auth: {
        snapshotComplete: true,
        caughtUp: true,
        valid: true,
        mismatchCount: 0,
      },
    },
    contentObjects: { coverage: 1, failureCount: 0 },
    userDomainWraps: { coverage: 1, pending: 0 },
    backupRestore: { passed: true },
    schemaOwnership: {
      coverage: 1,
      crossSchemaWriteViolations: 0,
      moduleRolesEnforced: true,
    },
    reverseShadow: {
      enabled: true,
      observationDays: 7,
      readFallbackHits: 0,
    },
    legacyRuntime: {
      routeHits: 0,
      toolExecutorHits: 0,
      sqliteReadHits: 0,
      sharedDirectoryHits: 0,
      memoryTransportHits: 0,
      monolithImageReadOnly: true,
    },
    keyCustody: {
      remoteAuthority: true,
      masterKeyMountedOutsideCustody: false,
      localMaterialReadHits: 0,
      decryptOnlyReadHits: 0,
      observationDays: 7,
      wrapUnwrapDrillPassed: true,
      rotationRecoveryPassed: true,
    },
    runtimeDrills: {
      chatAgentRolloutPassed: true,
      identityCustodyFailurePassed: true,
      cryptoIsolationPassed: true,
    },
  };
}

describe("micro-module cutover gate", () => {
  test("accepts a fully verified distributed foundation", () => {
    expect(
      evaluateCutover({
        env: distributedEnv(),
        evidence: evidence(),
        strict: true,
      })
    ).toMatchObject({ ready: true, findings: [] });
  });

  test("blocks cloud topology from silently using local fallbacks", () => {
    const env = distributedEnv();
    env.ATHENA_DATABASE_PROVIDER = "sqlite";
    env.ATHENA_CONTENT_STORE = "local";
    env.ATHENA_READER_WORKER_FALLBACK_IN_PROCESS = "true";
    expect(
      evaluateCutover({ env, evidence: evidence(), strict: true })
    ).toMatchObject({
      ready: false,
      findings: expect.arrayContaining([
        "postgresql_not_authoritative",
        "object_storage_not_authoritative",
        "reader_in_process_fallback_enabled",
      ]),
    });
  });

  test("requires a seven-day zero-hit observation before retirement", () => {
    const invalid = evidence();
    invalid.reverseShadow.readFallbackHits = 1;
    invalid.legacyRuntime.routeHits = 2;
    expect(
      evaluateCutover({
        env: distributedEnv(),
        evidence: invalid,
        phase: "retirement",
        strict: true,
      })
    ).toMatchObject({
      ready: false,
      findings: expect.arrayContaining([
        "legacy_read_fallback_hits_present",
        "legacy_route_hits_present",
      ]),
    });
  });

  test("blocks retirement while platform keys or local fallbacks remain", () => {
    const invalid = evidence();
    invalid.keyCustody.masterKeyMountedOutsideCustody = true;
    invalid.keyCustody.localMaterialReadHits = 1;
    invalid.legacyRuntime.sqliteReadHits = 1;
    const env = distributedEnv();
    env.ATHENA_MEMORY_TRANSPORT_FALLBACK = "true";
    expect(
      evaluateCutover({
        env,
        evidence: invalid,
        phase: "retirement",
        strict: true,
      })
    ).toMatchObject({
      ready: false,
      findings: expect.arrayContaining([
        "platform_key_still_mounted_outside_custody",
        "local_key_material_read_hits_present",
        "legacy_sqlite_read_hits_present",
        "memory_transport_fallback_not_closed",
      ]),
    });
  });
});
