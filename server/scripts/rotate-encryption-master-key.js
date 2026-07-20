#!/usr/bin/env node

console.error(
  JSON.stringify(
    {
      success: false,
      error: "legacy_master_key_rotation_disabled",
      reason:
        "Direct raw-key rotation bypasses Key Custody registry, Canary, write barriers, recovery bundles, and persisted verification.",
      replacement:
        "ATHENA_KEY_RECOVERY_PASSPHRASE=<secret> node server/scripts/athena-keyctl.js rotate --apply --recovery-bundle <private-path>",
    },
    null,
    2
  )
);
process.exitCode = 1;
