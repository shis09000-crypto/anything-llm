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
  return `Rebind security audit checkpoint metadata after a custody provider migration

Usage:
  node scripts/rebind-security-audit-checkpoint-metadata.js \\
    --source-origin hkdf-derived-from-<provider> --env <environment>
  node scripts/rebind-security-audit-checkpoint-metadata.js \\
    --source-origin hkdf-derived-from-<provider> \\
    --apply --execute --env <environment>

Dry-run is the default. Apply mode verifies the complete hash chain and every
classical/PQ signature through an in-memory migration view, atomically rewrites
the matching checkpoint metadata, retains the previous envelope as forensic
history, and then runs the normal strict verifier before commit. It does not
add a legacy key-origin allowlist or runtime verification bypass.`;
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }
  const sourceKeyOrigin = String(argValue("--source-origin") || "").trim();
  if (!sourceKeyOrigin) throw new Error("source_origin_required");
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
    rebindSecurityAuditCheckpointMetadata,
  } = require("../utils/security/auditLedger");
  try {
    const result = await rebindSecurityAuditCheckpointMetadata({
      sourceKeyOrigin,
      dryRun: !apply,
    });
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: apply ? "applied" : "dry-run",
          environment: runtime.appEnv,
          ...result,
          ...(!apply
            ? {
                instruction:
                  "Repeat with --apply --execute and an explicit --env to commit.",
              }
            : {}),
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
        error:
          error?.code || error?.message || "checkpoint_metadata_rebind_failed",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
