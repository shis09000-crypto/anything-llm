const {
  evaluate,
  topologyFindings,
} = require("../../scripts/generate-preproduction-cutover-evidence");
const { loadManifests } = require("../../utils/modulePlatform/manifestRegistry");

const EXPECTED_MODULES = loadManifests().length;

function input(value) {
  return { file: "fixture.json", value, error: null };
}

function topology() {
  return {
    version: "athena.preproduction-topology-evidence:v1",
    ready: true,
    manifests: { count: EXPECTED_MODULES },
    authoritativePaths: {
      database: "postgresql",
      broadcast: "nats",
      contentStore: "s3",
      serviceMtlsRequired: true,
      durableReaderQueue: true,
      logicalSchemaCutover: true,
      sharedStorageCutover: true,
    },
    operations: {
      counts: {
        total: EXPECTED_MODULES,
        healthy: EXPECTED_MODULES,
        unknown: 0,
        unmonitored: 0,
        degraded: 0,
      },
      infrastructureCounts: {
        total: 9,
        healthy: 9,
        unknown: 0,
        unmonitored: 0,
        degraded: 0,
      },
      heartbeats: {
        expected: EXPECTED_MODULES,
        fresh: EXPECTED_MODULES,
        stale: 0,
        missing: [],
      },
    },
    prometheus: {
      expected: EXPECTED_MODULES,
      up: EXPECTED_MODULES,
      missing: [],
    },
  };
}

describe("preproduction cutover qualification evidence", () => {
  it("requires complete operations and authoritative-path coverage", () => {
    expect(topologyFindings(topology())).toEqual([]);
    expect(
      topologyFindings({
        ...topology(),
        operations: {
          ...topology().operations,
          counts: { ...topology().operations.counts, unknown: 1 },
        },
      })
    ).toContain("operations_module_coverage_incomplete");
  });

  it("does not treat operational topology readiness as cutover authority", () => {
    const operationalOnly = topology();
    operationalOnly.operationalReady = true;
    operationalOnly.productionCutoverReady = false;
    operationalOnly.authoritativePaths.logicalSchemaCutover = false;
    operationalOnly.authoritativePaths.sharedStorageCutover = false;

    expect(topologyFindings(operationalOnly)).toContain(
      "authoritative_paths_incomplete"
    );
  });

  it("accepts only a complete real-drill evidence set", () => {
    const findings = evaluate({
      topology: input(topology()),
      rolling: input({
        version: "athena.preproduction-rolling-release-drill:v1",
        passed: true,
        protectedServicesUnchanged: true,
        targetServicesRecreated: true,
        recoveredAllModules: true,
        expectedModules: EXPECTED_MODULES,
      }),
      disconnect: input({
        version: "athena.preproduction-disconnect-recovery-drill:v1",
        passed: true,
        streamGatewayRestarted: true,
        durableSequenceReplayVerified: true,
        duplicateEvents: 0,
        missingEvents: 0,
        recoveredAllModules: true,
        expectedModules: EXPECTED_MODULES,
      }),
      fault: input({
        version: "athena.preproduction-service-fault-drill:v1",
        passed: true,
        targetDegraded: true,
        protectedModulesHealthy: true,
        faultScopeContained: true,
        recoveredAllModules: true,
        expectedModules: EXPECTED_MODULES,
      }),
      backup: input({
        version: "athena.preproduction-backup-restore-drill:v1",
        passed: true,
        mainDatabaseExact: true,
        authDatabaseExact: true,
        objectStoreExact: true,
      }),
      crypto: input({
        version: "athena.crypto-account-isolation-drill:v1",
        passed: true,
        accounts: 2,
        liveServiceBoundary: true,
        concurrentPartitioning: true,
        ownerResolverVerified: true,
        privateClientIsolationVerified: true,
        cacheIsolationVerified: true,
        websocketIsolationVerified: true,
        credentialRotationInvalidation: true,
        ownerRevocationInvalidation: true,
        sensitiveScanPassed: true,
        sensitiveValuesEmitted: false,
      }),
      chatAgent: input({
        version: "athena.preproduction-chat-agent-continuity-drill:v1",
        passed: true,
        chatInFlightRolloutPassed: true,
        agentInFlightRolloutPassed: true,
        reconnectP95WithinTarget: true,
        duplicateMessages: 0,
        lostMessages: 0,
      }),
    });
    expect(findings).toEqual([]);
  });

  it("rejects registry-only Crypto isolation evidence", () => {
    const findings = evaluate({
      topology: input(topology()),
      rolling: {
        file: null,
        value: null,
        error: "rolling_missing",
      },
      disconnect: {
        file: null,
        value: null,
        error: "disconnect_missing",
      },
      fault: {
        file: null,
        value: null,
        error: "fault_missing",
      },
      backup: {
        file: null,
        value: null,
        error: "backup_missing",
      },
      crypto: input({
        version: "athena.crypto-account-isolation-drill:v1",
        passed: true,
        accounts: 2,
        liveServiceBoundary: false,
        concurrentPartitioning: true,
        ownerResolverVerified: false,
        privateClientIsolationVerified: true,
        cacheIsolationVerified: true,
        websocketIsolationVerified: false,
        credentialRotationInvalidation: true,
        ownerRevocationInvalidation: true,
        sensitiveScanPassed: true,
        sensitiveValuesEmitted: false,
      }),
      chatAgent: {
        file: null,
        value: null,
        error: "chat-agent_missing",
      },
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        "athena.crypto-account-isolation-drill:v1_liveServiceBoundary_invalid",
        "athena.crypto-account-isolation-drill:v1_ownerResolverVerified_invalid",
        "athena.crypto-account-isolation-drill:v1_websocketIsolationVerified_invalid",
      ])
    );
  });

  it("fails closed when in-flight Chat or Agent evidence is absent", () => {
    const findings = evaluate({
      topology: input(topology()),
      rolling: { file: null, value: null, error: "rolling_missing" },
      disconnect: { file: null, value: null, error: "disconnect_missing" },
      fault: { file: null, value: null, error: "fault_missing" },
      backup: { file: null, value: null, error: "backup_missing" },
      crypto: { file: null, value: null, error: "crypto_missing" },
      chatAgent: {
        file: null,
        value: null,
        error: "chat-agent_missing",
      },
    });
    expect(findings).toEqual(
      expect.arrayContaining(["chat-agent_missing", "rolling_missing"])
    );
  });
});
