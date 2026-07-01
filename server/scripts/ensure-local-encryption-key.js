#!/usr/bin/env node
process.env.NODE_ENV ||= "development";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MASTER_KEY_ENV } = require("../utils/security/constants");

const serverRoot = path.join(__dirname, "..");
const DEFAULT_ENV_FILE =
  process.env.NODE_ENV === "development"
    ? ".env.development"
    : process.env.DESKTOP_ENV_PATH || ".env";

function hasArg(name) {
  return process.argv.includes(name);
}

function getArgValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function parseEnvLines(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function isValidMasterKey(value) {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value.trim());
}

function keyFingerprint(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function appendEnvValue(filePath, key, value) {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "";
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const body = `${prefix}${key}=${value}\n`;
  fs.appendFileSync(filePath, body, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

async function main() {
  const apply = hasArg("--apply");
  const envFile = getArgValue("--env-file", DEFAULT_ENV_FILE);
  const envPath = path.isAbsolute(envFile)
    ? envFile
    : path.join(serverRoot, envFile);
  const content = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const values = parseEnvLines(content);
  const current = values[MASTER_KEY_ENV]?.trim();

  if (isValidMasterKey(current)) {
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: apply ? "apply" : "dry-run",
          envFile: envPath,
          action: "unchanged",
          keyPresent: true,
          keyValid: true,
          keyFingerprint: keyFingerprint(current),
        },
        null,
        2
      )
    );
    return;
  }

  if (current) {
    throw new Error(
      `${MASTER_KEY_ENV} exists in ${envPath} but is not a 64-character hex key. Refusing to overwrite it automatically.`
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  if (apply) appendEnvValue(envPath, MASTER_KEY_ENV, generated);

  console.log(
    JSON.stringify(
      {
        success: true,
        mode: apply ? "apply" : "dry-run",
        envFile: envPath,
        action: apply ? "created" : "would-create",
        keyPresent: apply,
        keyValid: apply,
        keyFingerprint: keyFingerprint(generated),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { success: false, error: error?.message || String(error) },
      null,
      2
    )
  );
  process.exit(1);
});
