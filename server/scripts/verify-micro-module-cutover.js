#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { loadManifests } = require("../utils/modulePlatform/manifestRegistry");

const EVIDENCE_VERSION = "athena.micro-module-cutover-evidence:v2";

function parseArgs(argv = process.argv.slice(2)) {
  const value = (name, fallback = null) => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    phase: value("phase", "foundation"),
    evidenceFile: value(
      "evidence",
      process.env.ATHENA_MICRO_MODULE_CUTOVER_EVIDENCE_FILE || null
    ),
    strict: argv.includes("--strict"),
  };
}

function present(value) {
  return Boolean(String(value || "").trim());
}

function topologyFindings(env = process.env, phase = "foundation") {
  const findings = [];
  if (
    !["cloud", "distributed"].includes(
      String(env.ATHENA_RUNTIME_TOPOLOGY || "").toLowerCase()
    )
  )
    findings.push("runtime_topology_not_distributed");
  if (env.ATHENA_DATABASE_PROVIDER !== "postgresql")
    findings.push("postgresql_not_authoritative");
  if (!present(env.ATHENA_POSTGRES_MAIN_URL))
    findings.push("main_database_url_missing");
  if (!present(env.ATHENA_POSTGRES_AUTH_URL))
    findings.push("auth_database_url_missing");
  if (env.ATHENA_BROADCAST_TRANSPORT !== "nats")
    findings.push("nats_transport_not_authoritative");
  if (!present(env.ATHENA_NATS_SERVERS)) findings.push("nats_servers_missing");
  if (env.ATHENA_CONTENT_STORE !== "s3")
    findings.push("object_storage_not_authoritative");
  if (!present(env.ATHENA_S3_BUCKET)) findings.push("object_bucket_missing");
  if (env.ATHENA_SERVICE_MTLS_REQUIRED !== "true")
    findings.push("service_mtls_not_required");
  if (env.ATHENA_READER_WORKER_QUEUE !== "true")
    findings.push("reader_durable_queue_disabled");
  if (env.ATHENA_READER_WORKER_FALLBACK_IN_PROCESS !== "false")
    findings.push("reader_in_process_fallback_enabled");
  if (env.ATHENA_MODULE_SCHEMA_CUTOVER !== "true")
    findings.push("logical_schema_cutover_not_authoritative");
  if (env.ATHENA_SHARED_STORAGE_CUTOVER !== "true")
    findings.push("shared_storage_cutover_not_authoritative");
  if (phase === "retirement") {
    if (!present(env.ATHENA_KEY_CUSTODY_URL))
      findings.push("remote_key_custody_url_missing");
    if (env.ATHENA_KEY_CUSTODY_CUTOVER !== "true")
      findings.push("remote_key_custody_not_authoritative");
    if (env.ATHENA_LEGACY_RUNTIME_WRITE_ENABLED !== "false")
      findings.push("legacy_runtime_writes_not_closed");
    if (env.ATHENA_SQLITE_RUNTIME_FALLBACK !== "false")
      findings.push("sqlite_runtime_fallback_not_closed");
    if (env.ATHENA_MEMORY_TRANSPORT_FALLBACK !== "false")
      findings.push("memory_transport_fallback_not_closed");
    if (env.ATHENA_MONOLITH_RUNTIME_MODE !== "read-only")
      findings.push("monolith_rollback_image_not_read_only");
  }
  return findings;
}

function evidenceFindings(evidence = null, phase = "foundation") {
  if (!evidence || typeof evidence !== "object")
    return ["cutover_evidence_missing"];
  const findings = [];
  if (evidence.version !== EVIDENCE_VERSION)
    findings.push("cutover_evidence_version_invalid");
  for (const database of ["main", "auth"]) {
    const status = evidence.databases?.[database];
    if (!status?.snapshotComplete)
      findings.push(`${database}_snapshot_incomplete`);
    if (!status?.caughtUp) findings.push(`${database}_cdc_not_caught_up`);
    if (!status?.valid || Number(status?.mismatchCount || 0) !== 0)
      findings.push(`${database}_verification_failed`);
  }
  if (
    Number(evidence.contentObjects?.coverage || 0) !== 1 ||
    Number(evidence.contentObjects?.failureCount || 0) !== 0
  )
    findings.push("content_object_coverage_incomplete");
  if (
    Number(evidence.userDomainWraps?.coverage || 0) !== 1 ||
    Number(evidence.userDomainWraps?.pending || 0) !== 0
  )
    findings.push("user_domain_wrap_coverage_incomplete");
  if (evidence.backupRestore?.passed !== true)
    findings.push("backup_restore_not_verified");
  if (evidence.reverseShadow?.enabled !== true)
    findings.push("reverse_shadow_not_enabled");
  if (
    Number(evidence.schemaOwnership?.coverage || 0) !== 1 ||
    Number(evidence.schemaOwnership?.crossSchemaWriteViolations || 0) !== 0
  )
    findings.push("schema_ownership_coverage_incomplete");
  if (phase === "retirement") {
    if (evidence.schemaOwnership?.moduleRolesEnforced !== true)
      findings.push("module_database_roles_not_enforced");
    if (Number(evidence.reverseShadow?.observationDays || 0) < 7)
      findings.push("reverse_shadow_observation_too_short");
    if (Number(evidence.reverseShadow?.readFallbackHits || 0) !== 0)
      findings.push("legacy_read_fallback_hits_present");
    if (Number(evidence.legacyRuntime?.routeHits || 0) !== 0)
      findings.push("legacy_route_hits_present");
    if (Number(evidence.legacyRuntime?.toolExecutorHits || 0) !== 0)
      findings.push("legacy_tool_executor_hits_present");
    if (Number(evidence.legacyRuntime?.sqliteReadHits || 0) !== 0)
      findings.push("legacy_sqlite_read_hits_present");
    if (Number(evidence.legacyRuntime?.sharedDirectoryHits || 0) !== 0)
      findings.push("legacy_shared_directory_hits_present");
    if (Number(evidence.legacyRuntime?.memoryTransportHits || 0) !== 0)
      findings.push("legacy_memory_transport_hits_present");
    if (evidence.legacyRuntime?.monolithImageReadOnly !== true)
      findings.push("monolith_rollback_image_not_read_only");
    if (evidence.keyCustody?.remoteAuthority !== true)
      findings.push("remote_key_custody_not_verified");
    if (evidence.keyCustody?.masterKeyMountedOutsideCustody !== false)
      findings.push("platform_key_still_mounted_outside_custody");
    if (Number(evidence.keyCustody?.localMaterialReadHits || 0) !== 0)
      findings.push("local_key_material_read_hits_present");
    if (Number(evidence.keyCustody?.decryptOnlyReadHits || 0) !== 0)
      findings.push("decrypt_only_key_read_hits_present");
    if (Number(evidence.keyCustody?.observationDays || 0) < 7)
      findings.push("key_custody_observation_too_short");
    if (evidence.keyCustody?.wrapUnwrapDrillPassed !== true)
      findings.push("key_custody_wrap_unwrap_drill_not_verified");
    if (evidence.keyCustody?.rotationRecoveryPassed !== true)
      findings.push("key_custody_rotation_recovery_not_verified");
    if (evidence.runtimeDrills?.chatAgentRolloutPassed !== true)
      findings.push("chat_agent_rollout_drill_not_verified");
    if (evidence.runtimeDrills?.identityCustodyFailurePassed !== true)
      findings.push("identity_custody_failure_drill_not_verified");
    if (evidence.runtimeDrills?.cryptoIsolationPassed !== true)
      findings.push("crypto_isolation_drill_not_verified");
  }
  return findings;
}

function loadEvidence(filePath) {
  if (!filePath) return null;
  const target = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function evaluateCutover({
  env = process.env,
  evidence = null,
  phase = "foundation",
  strict = false,
} = {}) {
  const findings = topologyFindings(env, phase);
  if (strict || evidence) findings.push(...evidenceFindings(evidence, phase));
  const manifests = loadManifests();
  return {
    version: EVIDENCE_VERSION,
    phase,
    ready: findings.length === 0,
    findings,
    topology: {
      database: env.ATHENA_DATABASE_PROVIDER || "sqlite",
      broadcast: env.ATHENA_BROADCAST_TRANSPORT || "memory",
      contentStore: env.ATHENA_CONTENT_STORE || "local",
      serviceMtlsRequired: env.ATHENA_SERVICE_MTLS_REQUIRED === "true",
      durableReaderQueue: env.ATHENA_READER_WORKER_QUEUE === "true",
      logicalSchemaCutover: env.ATHENA_MODULE_SCHEMA_CUTOVER === "true",
      sharedStorageCutover: env.ATHENA_SHARED_STORAGE_CUTOVER === "true",
    },
    modules: {
      count: manifests.length,
      fingerprints: manifests.map(({ id, fingerprint }) => ({
        id,
        fingerprint,
      })),
    },
  };
}

function main() {
  const options = parseArgs();
  if (!["foundation", "retirement"].includes(options.phase))
    throw new Error("cutover_phase_invalid");
  const result = evaluateCutover({
    env: process.env,
    evidence: loadEvidence(options.evidenceFile),
    phase: options.phase,
    strict: options.strict,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        ready: false,
        error: error.code || error.message || "cutover_verification_failed",
      })
    );
    process.exitCode = 1;
  }
}

module.exports = {
  EVIDENCE_VERSION,
  evaluateCutover,
  evidenceFindings,
  parseArgs,
  topologyFindings,
};
