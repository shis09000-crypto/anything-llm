const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SERVICE_IDENTITY_SUITE = "service-identity-mtls-v1";

function normalizedEnvironment(env = process.env) {
  return String(env.APP_ENV || env.NODE_ENV || "development")
    .trim()
    .toLowerCase();
}

function expectedServiceId(role, env = process.env) {
  const normalizedRole = String(role || "")
    .trim()
    .toLowerCase();
  const rolePrefix = `ATHENA_${normalizedRole
    .toUpperCase()
    .replace(/-/g, "_")}_SERVICE_ID`;
  const roleConfigured = String(env[rolePrefix] || "").trim();
  if (roleConfigured) return roleConfigured;

  const currentRole = String(env.ATHENA_RUNTIME_ROLE || "")
    .trim()
    .toLowerCase();
  const processConfigured = String(env.ATHENA_SERVICE_ID || "").trim();
  if (processConfigured && currentRole === normalizedRole)
    return processConfigured;

  return `spiffe://athena/${normalizedEnvironment(env)}/${normalizedRole}`;
}

function fileSetting(role, suffix, env = process.env) {
  const prefix = `ATHENA_${String(role).toUpperCase().replace(/-/g, "_")}_MTLS_`;
  return String(
    env[`${prefix}${suffix}`] || env[`ATHENA_MTLS_${suffix}`] || ""
  ).trim();
}

function identitySettings(role, env = process.env) {
  return {
    role,
    serviceId: expectedServiceId(role, env),
    caFile: fileSetting(role, "CA_FILE", env),
    certFile: fileSetting(role, "CERT_FILE", env),
    keyFile: fileSetting(role, "KEY_FILE", env),
    nextCertFile: fileSetting(role, "NEXT_CERT_FILE", env),
    nextKeyFile: fileSetting(role, "NEXT_KEY_FILE", env),
    serverName: fileSetting(role, "SERVER_NAME", env) || undefined,
  };
}

function privateFile(filePath, label) {
  const target = path.resolve(filePath);
  const stat = fs.statSync(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error(`${label}_permissions_unsafe`);
  return fs.readFileSync(target, "utf8");
}

function certificateHasIdentity(certificate, serviceId) {
  return String(certificate.subjectAltName || "")
    .split(/,\s*/)
    .some((entry) => entry === `URI:${serviceId}`);
}

function certificateMatchesPrivateKey(certificate, privateKey) {
  try {
    const certificatePublicKey = certificate.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const privatePublicKey = crypto
      .createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64");
    return certificatePublicKey === privatePublicKey;
  } catch {
    return false;
  }
}

function certificateBundle(value = "") {
  return (
    String(value).match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
    ) || []
  ).map((pem) => new crypto.X509Certificate(pem));
}

function certificateChainsToCA(certificate, caBundle = "") {
  return certificateBundle(caBundle).some((ca) => {
    try {
      return certificate.checkIssued(ca) && certificate.verify(ca.publicKey);
    } catch {
      return false;
    }
  });
}

function validatedIdentityCandidate({
  role,
  serviceId,
  certFile,
  keyFile,
  ca,
  slot,
  env,
}) {
  if (!certFile || !keyFile) return null;
  const cert = fs.readFileSync(path.resolve(certFile), "utf8");
  const key = privateFile(keyFile, `${role}_mtls_${slot}_private_key`);
  const [x509] = certificateBundle(cert);
  if (!x509) throw new Error(`service_identity_certificate_invalid:${role}`);
  if (!certificateHasIdentity(x509, serviceId))
    throw new Error(`service_identity_san_mismatch:${role}`);
  if (!certificateChainsToCA(x509, ca))
    throw new Error(`service_identity_ca_verification_failed:${role}`);
  const validFrom = Date.parse(x509.validFrom);
  const validTo = Date.parse(x509.validTo);
  const now = Date.now();
  if (!Number.isFinite(validFrom) || validFrom > now + 60_000)
    throw new Error(`service_identity_certificate_not_yet_valid:${role}`);
  if (!Number.isFinite(validTo) || validTo <= now)
    throw new Error(`service_identity_certificate_expired:${role}`);
  const minimumRemaining = Math.max(
    60_000,
    Number(env.ATHENA_MTLS_MIN_REMAINING_MS || 5 * 60 * 1000)
  );
  if (validTo - now < minimumRemaining)
    throw new Error(`service_identity_certificate_expiring:${role}`);
  if (!certificateMatchesPrivateKey(x509, key))
    throw new Error(`service_identity_key_mismatch:${role}`);
  return { cert, key, x509, validFrom, validTo, slot };
}

function loadServiceIdentity(
  role,
  {
    env = process.env,
    required = env.ATHENA_SERVICE_MTLS_REQUIRED === "true",
  } = {}
) {
  const settings = identitySettings(role, env);
  if (!settings.caFile || !settings.certFile || !settings.keyFile) {
    if (!required) return null;
    throw new Error(`service_identity_files_missing:${role}`);
  }
  const ca = fs.readFileSync(path.resolve(settings.caFile), "utf8");
  if (!certificateBundle(ca).length)
    throw new Error(`service_identity_ca_invalid:${role}`);
  if (Boolean(settings.nextCertFile) !== Boolean(settings.nextKeyFile))
    throw new Error(`service_identity_next_pair_incomplete:${role}`);
  const primary = validatedIdentityCandidate({
    role,
    serviceId: settings.serviceId,
    certFile: settings.certFile,
    keyFile: settings.keyFile,
    ca,
    slot: "primary",
    env,
  });
  const next = validatedIdentityCandidate({
    role,
    serviceId: settings.serviceId,
    certFile: settings.nextCertFile,
    keyFile: settings.nextKeyFile,
    ca,
    slot: "next",
    env,
  });
  const switchWindow = Math.max(
    5 * 60 * 1000,
    Number(env.ATHENA_MTLS_ROTATION_SWITCH_MS || 24 * 60 * 60 * 1000)
  );
  const selected =
    next && primary.validTo - Date.now() <= switchWindow ? next : primary;
  const { observeCertificateRemaining } = require("./cryptoObservability");
  observeCertificateRemaining({
    role,
    slot: "primary",
    validTo: new Date(primary.validTo).toISOString(),
  });
  if (next)
    observeCertificateRemaining({
      role,
      slot: "next",
      validTo: new Date(next.validTo).toISOString(),
    });
  observeCertificateRemaining({
    role,
    slot: "selected",
    validTo: new Date(selected.validTo).toISOString(),
  });
  return {
    suiteId: SERVICE_IDENTITY_SUITE,
    role,
    serviceId: settings.serviceId,
    fingerprint256: selected.x509.fingerprint256,
    serialNumber: selected.x509.serialNumber,
    validFrom: selected.x509.validFrom,
    validTo: selected.x509.validTo,
    certificateSlot: selected.slot,
    ca,
    cert: selected.cert,
    key: selected.key,
    serverName: settings.serverName,
  };
}

function serviceIdentitySummary(role, options = {}) {
  try {
    const identity = loadServiceIdentity(role, options);
    return identity
      ? {
          configured: true,
          valid: true,
          suiteId: identity.suiteId,
          serviceId: identity.serviceId,
          fingerprint256: identity.fingerprint256,
          serialNumber: identity.serialNumber,
          validFrom: identity.validFrom,
          validTo: identity.validTo,
          certificateSlot: identity.certificateSlot,
        }
      : { configured: false, valid: true, serviceId: expectedServiceId(role) };
  } catch (error) {
    return {
      configured: false,
      valid: false,
      serviceId: expectedServiceId(role),
      error: error.message,
    };
  }
}

module.exports = {
  SERVICE_IDENTITY_SUITE,
  certificateHasIdentity,
  certificateBundle,
  certificateChainsToCA,
  certificateMatchesPrivateKey,
  expectedServiceId,
  identitySettings,
  loadServiceIdentity,
  serviceIdentitySummary,
};
