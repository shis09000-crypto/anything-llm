#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function hasArg(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function usage() {
  return `Athena Phase 4 key closure control

Usage:
  node scripts/finalize-key-closure.js audit --key-id <id>
  node scripts/finalize-key-closure.js start-observation --key-id <id> --apply --execute --env <environment>
  node scripts/finalize-key-closure.js record-evidence --key-id <id> --kind <device-recovery|agent-headless|backup-restore> --evidence <path> --apply --execute --env <environment>
  node scripts/finalize-key-closure.js close-legacy-writes --key-id <id> --apply --execute --env <environment>
  node scripts/finalize-key-closure.js retire --key-id <id> --apply --execute --env <environment>

Mutating commands require both --apply and --execute. Retirement cannot bypass
migration coverage, drill evidence, decrypt-only observation, or zero-read gates.`;
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (!command || ["help", "-h", "--help"].includes(command)) {
    console.log(usage());
    return;
  }
  const keyId = arg("--key-id");
  if (!keyId) throw new Error("key_id_required");
  const mutation = command !== "audit";
  const apply = hasArg("--apply") && hasArg("--execute");
  await bootstrapCliRuntime({
    access: mutation && apply ? "write" : "read",
    execute: mutation && apply,
    requiredTables: [
      "security_key_registry",
      "security_key_events",
      "users",
      "user_domain_key_wraps",
      "_prisma_migrations",
    ],
  });
  const {
    closeLegacyWritesAfterAudit,
    keyClosureAudit,
    keyClosureRetirementProof,
    readDrillEvidence,
    recordClosureEvidence,
    startDecryptOnlyObservation,
  } = require("../utils/security/keyClosure");

  if (command === "audit") {
    output({ success: true, audit: await keyClosureAudit(keyId) });
    return;
  }
  if (!apply) {
    output({
      success: true,
      mode: "dry-run",
      command,
      keyId,
      requestedApply: hasArg("--apply"),
      audit: await keyClosureAudit(keyId),
      instruction:
        "Repeat with --apply --execute and an explicit --env to mutate.",
    });
    return;
  }
  if (command === "start-observation") {
    const event = await startDecryptOnlyObservation(keyId);
    output({ success: true, mode: "applied", event });
    return;
  }
  if (command === "record-evidence") {
    const kind = arg("--kind");
    const evidencePath = arg("--evidence");
    if (!kind || !evidencePath) throw new Error("evidence_input_required");
    const event = await recordClosureEvidence(
      keyId,
      kind,
      readDrillEvidence(evidencePath)
    );
    output({ success: true, mode: "applied", event });
    return;
  }
  if (command === "close-legacy-writes") {
    const result = await closeLegacyWritesAfterAudit(keyId);
    output({ success: true, mode: "applied", result });
    return;
  }
  if (command === "retire") {
    const { DataAccessCenter } = require("../utils/dataAccess");
    const { keyState, retireKey } = require("../utils/security/keyCustody");
    const registry = await DataAccessCenter.securityKey.registryByKeyId({
      keyId,
    });
    const providerState = keyState(keyId);
    if (
      registry?.status === "retired" &&
      providerState?.status === "retired" &&
      providerState.materialPresent === false
    ) {
      output({
        success: true,
        mode: "already-retired",
        keyId,
        status: "retired",
      });
      return;
    }
    if (registry?.status === "retiring") {
      if (
        providerState?.status === "retired" &&
        providerState.materialPresent === false
      ) {
        await DataAccessCenter.securityKey.updateRegistry({
          keyId,
          updates: { status: "retired", retiredAt: new Date() },
        });
        await DataAccessCenter.securityKey.appendEvent({
          event: "key_closure_retirement_reconciled",
          keyId,
          purpose: "server-data-at-rest",
          metadata: { providerState },
        });
        output({
          success: true,
          mode: "reconciled",
          keyId,
          status: "retired",
        });
        return;
      }
      await DataAccessCenter.securityKey.updateRegistry({
        keyId,
        updates: { status: "decrypt_only" },
      });
    }
    const migrationProof =
      await require("../utils/security/userDomainRetirementGuard").platformKeyRetirementProof(
        keyId
      );
    const closureProof = await keyClosureRetirementProof(keyId);
    await DataAccessCenter.securityKey.updateRegistry({
      keyId,
      updates: {
        status: "retiring",
        metadata: {
          ...(registry?.metadata || {}),
          closureGateHash: closureProof.gateHash,
          retirementStartedAt: new Date().toISOString(),
        },
      },
    });
    try {
      retireKey(keyId, undefined, migrationProof, closureProof);
    } catch (error) {
      await DataAccessCenter.securityKey.updateRegistry({
        keyId,
        updates: { status: "decrypt_only" },
      });
      throw error;
    }
    await DataAccessCenter.securityKey.updateRegistry({
      keyId,
      updates: { status: "retired", retiredAt: new Date() },
    });
    await DataAccessCenter.securityKey.appendEvent({
      event: "key_closure_key_retired",
      keyId,
      purpose: "server-data-at-rest",
      metadata: {
        migrationProofGeneratedAt: migrationProof.generatedAt,
        closureProofGeneratedAt: closureProof.generatedAt,
        gateHash: closureProof.gateHash,
      },
    });
    output({
      success: true,
      mode: "applied",
      keyId,
      status: "retired",
    });
    return;
  }
  throw new Error("unsupported_key_closure_command");
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error.message, code: error.code || null },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([
      require("../utils/prisma").$disconnect(),
      require("../utils/authPrisma").$disconnect(),
    ]);
  });
