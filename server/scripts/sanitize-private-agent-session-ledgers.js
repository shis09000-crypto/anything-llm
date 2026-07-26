#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

async function main() {
  const apply = process.argv.includes("--apply");
  await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute: process.argv.includes("--execute"),
    requiredTables: [],
  });
  const {
    sanitizeAccountPrivateSessionLedgers,
  } = require("../utils/agents/agentSessionLedger");
  const result = sanitizeAccountPrivateSessionLedgers({ apply });
  console.log(
    JSON.stringify(
      {
        success: true,
        mode: apply ? "applied" : "dry-run",
        ...result,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      success: false,
      error: error.code || error.message || "ledger_sanitization_failed",
    })
  );
  process.exit(1);
});
