const {
  evaluate,
  topologyFindings,
} = require("../../scripts/generate-preproduction-cutover-evidence");

function input(value) {
  return { file: "fixture.json", value, error: null };
}

function topology() {
  return {
    version: "athena.preproduction-topology-evidence:v1",
    ready: true,
    authoritativePaths: {
      database: "postgresql",
      broadcast: "nats",
      contentStore: "s3",
      serviceMtlsRequired: true,
      durableReaderQueue: true,
    },
    operations: {
      counts: {
        total: 20,
        healthy: 20,
        unknown: 0,
        unmonitored: 0,
        degraded: 0,
      },
      heartbeats: {
        expected: 20,
        fresh: 20,
        stale: 0,
        missing: [],
      },
    },
    prometheus: { expected: 16, up: 16, missing: [] },
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
    ).toContain("operations_coverage_not_20_of_20");
  });

  it("accepts only a complete real-drill evidence set", () => {
    const findings = evaluate({
      topology: input(topology()),
      rolling: input({
        version: "athena.preproduction-rolling-release-drill:v1",
        passed: true,
        protectedServicesUnchanged: true,
        targetServicesRecreated: true,
        recovered20Of20: true,
      }),
      disconnect: input({
        version: "athena.preproduction-disconnect-recovery-drill:v1",
        passed: true,
        streamGatewayRestarted: true,
        durableSequenceReplayVerified: true,
        duplicateEvents: 0,
        missingEvents: 0,
        recovered20Of20: true,
      }),
      fault: input({
        version: "athena.preproduction-service-fault-drill:v1",
        passed: true,
        targetDegraded: true,
        protectedModulesHealthy: true,
        faultScopeContained: true,
        recovered20Of20: true,
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
