#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function verifyDatabase(sourcePath, destinationPath, execute) {
  if (!execute) {
    const source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const quickCheck = source.pragma("quick_check");
      const foreignKeys = source.pragma("foreign_key_check");
      return {
        sourcePath,
        destinationPath,
        mode: "dry-run",
        quickCheck: quickCheck[0]?.quick_check || null,
        foreignKeyViolationCount: foreignKeys.length,
      };
    } finally {
      source.close();
    }
  }
  fs.mkdirSync(path.dirname(destinationPath), {
    recursive: true,
    mode: 0o700,
  });
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    source.exec(`VACUUM INTO '${destinationPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  fs.chmodSync(destinationPath, 0o600);
  const recovered = new Database(destinationPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const quickCheck = recovered.pragma("quick_check");
    const foreignKeys = recovered.pragma("foreign_key_check");
    if (quickCheck[0]?.quick_check !== "ok" || foreignKeys.length) {
      throw new Error("recovered_database_integrity_failed");
    }
    return {
      sourcePath,
      destinationPath,
      mode: "executed",
      bytes: fs.statSync(destinationPath).size,
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
    };
  } finally {
    recovered.close();
  }
}

function verifyKeyCustody() {
  const index = process.argv.indexOf("--key-id");
  const keyId = index >= 0 ? process.argv[index + 1] : null;
  return require("../utils/security/keyCustody").verifyKeyCustodyRoundTrip(
    keyId
  );
}

async function main() {
  const execute = process.argv.includes("--execute");
  const runtime = await bootstrapCliRuntime({
    access: execute ? "write" : "read",
    execute,
    requiredTables: ["users", "_prisma_migrations"],
  });
  if (runtime.databaseProvider !== "sqlite") {
    throw new Error("local_dr_drill_currently_requires_sqlite");
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const root = path.resolve(
    process.env.ATHENA_DR_DRILL_OUTPUT_DIR ||
      path.join(__dirname, "../../output/security/drills", stamp)
  );
  const result = {
    success: true,
    format: "athena-local-dr-drill:v1",
    environment: runtime.appEnv,
    mode: execute ? "executed" : "dry-run",
    databases: [
      verifyDatabase(
        runtime.databasePath,
        path.join(root, "main-recovered.db"),
        execute
      ),
      verifyDatabase(
        runtime.authDatabasePath,
        path.join(root, "auth-recovered.db"),
        execute
      ),
    ],
    keyCustody: verifyKeyCustody(),
    completedAt: new Date().toISOString(),
    limitation:
      "Local evidence only. Cross-account and cross-region controls require signed platform evidence.",
  };
  if (execute) {
    fs.writeFileSync(
      path.join(root, "drill-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({ success: false, error: error.message }, null, 2)
  );
  process.exitCode = 1;
});
