#!/usr/bin/env node
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function hasArg(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function main() {
  const requestedApply = hasArg("--apply");
  const execute = hasArg("--execute");
  const apply = requestedApply && execute;
  await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute,
    requiredTables: ["security_key_registry", "_prisma_migrations"],
  });

  const envFile = arg("--env-file");
  if (envFile) {
    const {
      EnvFileKeyProvider,
    } = require("../utils/security/keyCustody/providers");
    const {
      resetKeyProviderForTests,
    } = require("../utils/security/keyCustody");
    resetKeyProviderForTests(
      new EnvFileKeyProvider({
        env: process.env,
        envPath: path.resolve(envFile),
      })
    );
  }
  const { health } = require("../utils/security/keyCustody");
  const { runSecurityPreflight } = require("../utils/security/keyLifecycle");

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "dry-run",
          provider: health(),
          action: health().ok
            ? "would-verify-existing"
            : "would-bootstrap-only-if-no-historical-ciphertext",
          delegatedTo: "athena-keyctl bootstrap",
          ...(requestedApply
            ? {
                instruction:
                  "Apply requires --apply --execute and APP_ENV or --env.",
              }
            : {}),
        },
        null,
        2
      )
    );
    return;
  }

  const runtime = await runSecurityPreflight({
    runtimeRole: "legacy-ensure-key-wrapper",
    allowGenerate: true,
  });
  console.log(
    JSON.stringify(
      {
        success: runtime.status === "ready",
        mode: "apply",
        delegatedTo: "athena-keyctl bootstrap",
        runtime,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: error?.message || String(error),
        recovery: "Use: node server/scripts/athena-keyctl.js status|recover",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
