const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COLLECTOR_MANIFEST_PATH = path.resolve(
  __dirname,
  "../../server/module-manifests/collector.json"
);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function collectorManifest() {
  return JSON.parse(fs.readFileSync(COLLECTOR_MANIFEST_PATH, "utf8"));
}

function collectorReadinessEnvelope(ready) {
  const manifest = collectorManifest();
  const manifestFingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex");
  return {
    moduleId: manifest.id,
    role: manifest.runtimeRole,
    version: manifest.version,
    manifestFingerprint,
    status: ready ? "ready" : "not-ready",
    ready: Boolean(ready),
    source: "collector-runtime",
  };
}

module.exports = { collectorReadinessEnvelope };
