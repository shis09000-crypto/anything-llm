#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { forecastingRoot } = require("../utils/cryptoForecasting/constants");
const { CryptoForecastStore } = require("../utils/cryptoForecasting/store");
const {
  FEATURE_REGISTRY,
  FEATURE_REGISTRY_SHA256,
} = require("../utils/cryptoForecasting/contracts");

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function main() {
  const root = path.resolve(option("root", forecastingRoot()));
  const requestedOutput = option("output");
  if (!requestedOutput) throw new Error("missing_output");
  const output = path.resolve(requestedOutput);
  const source = path.join(root, "online-features.db");
  if (output.startsWith(`${root}${path.sep}`))
    throw new Error("snapshot_must_be_outside_persistent_store");
  if (!fs.existsSync(source)) throw new Error("forecast_store_missing");

  const store = new CryptoForecastStore({ root });
  try {
    const snapshot = await store.exportReadOnlySnapshot(output);
    const manifest = {
      schema: "athena.crypto.forecast-training-snapshot",
      schemaVersion: "2.0",
      generatedAt: new Date().toISOString(),
      source: "binance_public_data",
      databaseFile: path.basename(output),
      databaseBytes: snapshot.bytes,
      databaseSha256: snapshot.sha256,
      featureRegistryVersion: FEATURE_REGISTRY.registryVersion,
      featureRegistrySha256: FEATURE_REGISTRY_SHA256,
      marketDataAvailabilityContract: FEATURE_REGISTRY.availabilityContract,
      summary: snapshot.summary,
      handling: {
        readOnly: true,
        temporaryTrainingCopy: true,
        deleteAfterTraining: true,
      },
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = `${output}.manifest.json`;
    fs.writeFileSync(manifestPath, serialized, { mode: 0o400 });
    process.stdout.write(
      `${JSON.stringify({
        output,
        manifestPath,
        databaseBytes: snapshot.bytes,
        databaseSha256: snapshot.sha256,
        manifestSha256: sha256(Buffer.from(serialized)),
        summary: snapshot.summary,
      })}\n`
    );
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error?.code || error?.message || "snapshot_export_failed",
    })
  );
  process.exitCode = 1;
});
