#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const execute = process.argv.includes("--execute");
const outputIndex = process.argv.indexOf("--output-dir");
const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const names = ["audit", "release-edge", "release-dr", "agent-registry"];

function main() {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("node24_required_for_mldsa65_key_provisioning");
  if (!outputDir) throw new Error("--output-dir is required");
  const target = path.resolve(outputDir);
  const plan = names.map((name) => ({
    name,
    privateKeyFile: path.join(target, `${name}-mldsa65-private.pem`),
    publicKeyFile: path.join(target, `${name}-mldsa65-public.pem`),
  }));
  if (!execute) {
    console.log(JSON.stringify({ success: true, dryRun: true, plan }, null, 2));
    return;
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of plan) {
    if (
      fs.existsSync(entry.privateKeyFile) ||
      fs.existsSync(entry.publicKeyFile)
    )
      throw new Error(`refusing_to_overwrite_existing_key:${entry.name}`);
  }
  for (const entry of plan) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ml-dsa-65");
    fs.writeFileSync(
      entry.privateKeyFile,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600, flag: "wx" }
    );
    fs.writeFileSync(
      entry.publicKeyFile,
      publicKey.export({ format: "pem", type: "spki" }),
      { mode: 0o644, flag: "wx" }
    );
  }
  console.log(
    JSON.stringify({ success: true, dryRun: false, created: plan }, null, 2)
  );
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({ success: false, error: error.message }, null, 2)
  );
  process.exitCode = 1;
}
