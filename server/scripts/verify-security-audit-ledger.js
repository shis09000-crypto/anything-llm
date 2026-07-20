#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

async function main() {
  await bootstrapCliRuntime({
    requiredTables: ["security_audit_ledger", "security_audit_checkpoints"],
  });
  const { verifySecurityAudit } = require("../utils/security/auditLedger");
  const prisma = require("../utils/prisma");
  try {
    const result = await verifySecurityAudit();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((result) => {
    return result;
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        valid: false,
        error: error?.code || error?.message || "audit_verification_failed",
      })
    );
    process.exitCode = 1;
  });
