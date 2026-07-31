#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VERSION = "athena.preproduction-cutover-evidence:v1";

function argument(name, fallback = null) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readEvidence(name) {
  const file = argument(name);
  if (!file) return { file: null, value: null, error: `${name}_missing` };
  try {
    const target = path.resolve(file);
    return {
      file: target,
      value: JSON.parse(fs.readFileSync(target, "utf8")),
      error: null,
    };
  } catch {
    return { file, value: null, error: `${name}_invalid` };
  }
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function topologyFindings(value) {
  if (value?.version !== "athena.preproduction-topology-evidence:v1")
    return ["topology_evidence_invalid"];
  const counts = value.operations?.counts || {};
  const heartbeats = value.operations?.heartbeats || {};
  const findings = [];
  if (value.ready !== true) findings.push("topology_not_ready");
  if (
    counts.total !== 20 ||
    counts.healthy !== 20 ||
    counts.unknown !== 0 ||
    counts.unmonitored !== 0 ||
    counts.degraded !== 0
  )
    findings.push("operations_coverage_not_20_of_20");
  const infrastructure = value.operations?.infrastructureCounts || {};
  if (
    infrastructure.total !== 9 ||
    infrastructure.healthy !== 9 ||
    infrastructure.unknown !== 0 ||
    infrastructure.unmonitored !== 0 ||
    infrastructure.degraded !== 0
  )
    findings.push("operations_infrastructure_coverage_not_9_of_9");
  if (
    heartbeats.expected !== 20 ||
    heartbeats.fresh !== 20 ||
    heartbeats.stale !== 0 ||
    (heartbeats.missing || []).length !== 0
  )
    findings.push("operations_heartbeat_coverage_incomplete");
  if (
    value.prometheus?.expected !== 20 ||
    value.prometheus?.up !== 20 ||
    (value.prometheus?.missing || []).length !== 0
  )
    findings.push("prometheus_module_coverage_incomplete");
  const paths = value.authoritativePaths || {};
  if (
    paths.database !== "postgresql" ||
    paths.broadcast !== "nats" ||
    paths.contentStore !== "s3" ||
    paths.serviceMtlsRequired !== true ||
    paths.durableReaderQueue !== true ||
    paths.logicalSchemaCutover !== true ||
    paths.sharedStorageCutover !== true
  )
    findings.push("authoritative_paths_incomplete");
  return findings;
}

function exactDrill(value, version, required = {}) {
  const findings = [];
  if (value?.version !== version) findings.push(`${version}_invalid`);
  if (value?.passed !== true) findings.push(`${version}_not_passed`);
  for (const [field, expected] of Object.entries(required)) {
    if (value?.[field] !== expected)
      findings.push(`${version}_${field}_invalid`);
  }
  return findings;
}

function evaluate(inputs) {
  const findings = [];
  for (const input of Object.values(inputs)) {
    if (input.error) findings.push(input.error);
  }
  if (inputs.topology.value)
    findings.push(...topologyFindings(inputs.topology.value));
  if (inputs.rolling.value)
    findings.push(
      ...exactDrill(
        inputs.rolling.value,
        "athena.preproduction-rolling-release-drill:v1",
        {
          protectedServicesUnchanged: true,
          targetServicesRecreated: true,
          recovered20Of20: true,
        }
      )
    );
  if (inputs.disconnect.value)
    findings.push(
      ...exactDrill(
        inputs.disconnect.value,
        "athena.preproduction-disconnect-recovery-drill:v1",
        {
          streamGatewayRestarted: true,
          durableSequenceReplayVerified: true,
          duplicateEvents: 0,
          missingEvents: 0,
          recovered20Of20: true,
        }
      )
    );
  if (inputs.fault.value)
    findings.push(
      ...exactDrill(
        inputs.fault.value,
        "athena.preproduction-service-fault-drill:v1",
        {
          targetDegraded: true,
          protectedModulesHealthy: true,
          faultScopeContained: true,
          recovered20Of20: true,
        }
      )
    );
  if (inputs.backup.value)
    findings.push(
      ...exactDrill(
        inputs.backup.value,
        "athena.preproduction-backup-restore-drill:v1",
        {
          mainDatabaseExact: true,
          authDatabaseExact: true,
          objectStoreExact: true,
        }
      )
    );
  if (inputs.crypto.value)
    findings.push(
      ...exactDrill(
        inputs.crypto.value,
        "athena.crypto-account-isolation-drill:v1",
        {
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
        }
      )
    );
  if (inputs.chatAgent.value)
    findings.push(
      ...exactDrill(
        inputs.chatAgent.value,
        "athena.preproduction-chat-agent-continuity-drill:v1",
        {
          chatInFlightRolloutPassed: true,
          agentInFlightRolloutPassed: true,
          reconnectP95WithinTarget: true,
          duplicateMessages: 0,
          lostMessages: 0,
        }
      )
    );
  return [...new Set(findings)].sort();
}

function main() {
  if (process.env.APP_ENV !== "preproduction")
    throw new Error("preproduction_environment_required");
  const inputs = {
    topology: readEvidence("topology"),
    rolling: readEvidence("rolling"),
    disconnect: readEvidence("disconnect"),
    fault: readEvidence("fault"),
    backup: readEvidence("backup"),
    crypto: readEvidence("crypto"),
    chatAgent: readEvidence("chat-agent"),
  };
  const findings = evaluate(inputs);
  const evidence = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    environment: "preproduction",
    qualifiedForProductionCutoverPlanning: findings.length === 0,
    productionChanged: false,
    compatibilityContract: {
      externalRoutesChanged: false,
      promptOrRagSemanticsChanged: false,
      authenticationProtocolChanged: false,
      approvalUxChanged: false,
      purpose: "deployment-decoupling-only",
    },
    evidence: Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [
        name,
        input.value
          ? {
              version: input.value.version,
              passed: input.value.passed ?? input.value.ready ?? false,
              sha256: digest(input.value),
            }
          : null,
      ])
    ),
    findings,
  };
  const output = argument("output");
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.qualifiedForProductionCutoverPlanning) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        version: VERSION,
        qualifiedForProductionCutoverPlanning: false,
        error: error.code || error.message,
      })
    );
    process.exitCode = 1;
  }
}

module.exports = {
  VERSION,
  evaluate,
  topologyFindings,
};
