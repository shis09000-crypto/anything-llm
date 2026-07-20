const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

function secureFile(filePath, label) {
  const target = path.resolve(String(filePath || ""));
  const stat = fs.statSync(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    const error = new Error(`${label}_file_unsafe`);
    error.code = "SIEM_CREDENTIAL_FILE_UNSAFE";
    throw error;
  }
  const value = fs.readFileSync(target);
  if (label === "hmac" && value.length < 32) {
    const error = new Error("hmac_key_too_short");
    error.code = "SIEM_CREDENTIAL_TOO_SHORT";
    throw error;
  }
  return value;
}

function siemSettings(env = process.env) {
  return {
    url: String(env.ATHENA_SECURITY_SIEM_URL || "").trim(),
    hmacKeyFile: String(env.ATHENA_SECURITY_SIEM_HMAC_KEY_FILE || "").trim(),
    caFile: String(env.ATHENA_SECURITY_SIEM_CA_FILE || "").trim(),
    certFile: String(env.ATHENA_SECURITY_SIEM_CERT_FILE || "").trim(),
    keyFile: String(env.ATHENA_SECURITY_SIEM_KEY_FILE || "").trim(),
    timeoutMs: Math.max(
      Number(env.ATHENA_SECURITY_SIEM_TIMEOUT_MS || 5_000),
      1_000
    ),
  };
}

function validateSiemSettings(env = process.env) {
  const settings = siemSettings(env);
  const findings = [];
  if (!/^https:\/\//i.test(settings.url))
    findings.push("siem_https_url_required");
  if (!settings.hmacKeyFile) findings.push("siem_hmac_key_file_required");
  for (const [label, filePath] of [
    ["hmac", settings.hmacKeyFile],
    ["client_key", settings.keyFile],
  ]) {
    if (!filePath) continue;
    try {
      secureFile(filePath, label);
    } catch (error) {
      findings.push(error.message);
    }
  }
  if (Boolean(settings.certFile) !== Boolean(settings.keyFile)) {
    findings.push("siem_mtls_cert_and_key_must_be_paired");
  }
  return findings;
}

async function publishSecurityArchiveNotice(notice, env = process.env) {
  const settings = siemSettings(env);
  const findings = validateSiemSettings(env);
  if (findings.length) {
    const error = new Error(
      `security_siem_config_invalid:${findings.join(",")}`
    );
    error.code = "SECURITY_SIEM_CONFIG_INVALID";
    throw error;
  }
  const body = Buffer.from(JSON.stringify(notice));
  const key = secureFile(settings.hmacKeyFile, "hmac");
  const signature = crypto
    .createHmac("sha256", key)
    .update(body)
    .digest("base64url");
  const url = new URL(settings.url);
  const options = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    timeout: settings.timeoutMs,
    headers: {
      "content-type": "application/json",
      "content-length": body.length,
      "x-athena-event-signature": `hmac-sha256=${signature}`,
    },
    ...(settings.caFile
      ? { ca: fs.readFileSync(path.resolve(settings.caFile)) }
      : {}),
    ...(settings.certFile
      ? { cert: fs.readFileSync(path.resolve(settings.certFile)) }
      : {}),
    ...(settings.keyFile
      ? { key: secureFile(settings.keyFile, "client_key") }
      : {}),
  };
  await new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) resolve();
      else {
        reject(
          Object.assign(new Error("security_siem_delivery_failed"), {
            code: "SECURITY_SIEM_DELIVERY_FAILED",
            statusCode: response.statusCode,
          })
        );
      }
    });
    request.on("timeout", () =>
      request.destroy(new Error("security_siem_timeout"))
    );
    request.on("error", reject);
    request.end(body);
  });
  return { delivered: true };
}

module.exports = {
  publishSecurityArchiveNotice,
  secureFile,
  siemSettings,
  validateSiemSettings,
};
