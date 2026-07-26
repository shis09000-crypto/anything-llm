#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function provision({ output, execute = false } = {}) {
  if (!output) throw new Error("--output is required");
  const target = path.resolve(output);
  if (!execute) {
    return {
      success: true,
      mode: "dry-run",
      output: target,
      exists: fs.existsSync(target),
      action: fs.existsSync(target)
        ? "validate-existing"
        : "create-32-byte-pepper",
    };
  }
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 32) {
      throw new Error("existing_password_pepper_is_not_secure");
    }
    return { success: true, mode: "apply", output: target, created: false };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, crypto.randomBytes(32));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(target, 0o600);
  return { success: true, mode: "apply", output: target, created: true };
}

function main() {
  const result = provision({
    output: argument("--output"),
    execute: process.argv.includes("--execute"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({ success: false, error: error.message }, null, 2)
    );
    process.exitCode = 1;
  }
}

module.exports = { provision };
