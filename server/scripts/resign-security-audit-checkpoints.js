#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function usage() {
  return `Re-sign security audit checkpoints before retiring a platform key

Usage:
  node scripts/resign-security-audit-checkpoints.js --source-key <keyId>
  node scripts/resign-security-audit-checkpoints.js --source-key <keyId> \\
    --apply --execute --env <environment>

The target defaults to the active platform key. Applied migrations first verify
the complete ledger, update all matching checkpoints in one transaction, retain
the previous signatures as forensic history, and verify the ledger again before
commit.`;
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }
  const sourceKeyId = String(argValue("--source-key") || "").trim();
  const requestedTargetKeyId = String(argValue("--target-key") || "").trim();
  if (!sourceKeyId) throw new Error("source_key_required");
  const apply = hasArg("--apply") && hasArg("--execute");
  const runtime = await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute: apply,
    requiredTables: [
      "security_audit_ledger",
      "security_audit_checkpoints",
      "security_key_registry",
    ],
  });
  const prisma = require("../utils/prisma");
  const {
    resolveActiveKey,
    resolveKey,
  } = require("../utils/security/keyCustody");
  const {
    resignSecurityAuditCheckpoints,
    verifySecurityAudit,
  } = require("../utils/security/auditLedger");
  try {
    const targetKeyId =
      requestedTargetKeyId || resolveActiveKey()?.keyId || null;
    if (!targetKeyId) throw new Error("target_key_unavailable");
    if (!resolveKey(sourceKeyId)?.material)
      throw new Error("source_key_unavailable");
    if (!resolveKey(targetKeyId)?.material)
      throw new Error("target_key_unavailable");
    const [verification, checkpointCount] = await Promise.all([
      verifySecurityAudit(),
      prisma.security_audit_checkpoints.count({
        where: { keyId: sourceKeyId },
      }),
    ]);
    if (!verification.valid)
      throw new Error("security_audit_signature_migration_source_invalid");

    if (!apply) {
      console.log(
        JSON.stringify(
          {
            success: true,
            mode: "dry-run",
            environment: runtime.appEnv,
            sourceKeyId,
            targetKeyId,
            checkpointCount,
            ledger: {
              valid: verification.valid,
              entries: verification.entries,
              checkpoints: verification.checkpoints,
              headHash: verification.headHash,
            },
            instruction:
              "Repeat with --apply --execute and an explicit --env to commit.",
          },
          null,
          2
        )
      );
      return;
    }

    const result = await resignSecurityAuditCheckpoints({
      sourceKeyId,
      targetKeyId,
    });
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "applied",
          environment: runtime.appEnv,
          ...result,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: error?.code || error?.message || "checkpoint_resign_failed",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
