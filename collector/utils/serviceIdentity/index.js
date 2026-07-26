const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function environment() {
  return String(process.env.APP_ENV || process.env.NODE_ENV || "development");
}

function expectedIdentity(role) {
  const key = `ATHENA_${role.toUpperCase().replace(/-/g, "_")}_SERVICE_ID`;
  return process.env[key] || `spiffe://athena/${environment()}/${role}`;
}

function hasIdentity(certificate, identity) {
  return String(certificate.subjectAltName || "")
    .split(/,\s*/)
    .includes(`URI:${identity}`);
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

function privateKey(filePath, label) {
  const target = path.resolve(filePath);
  const stat = fs.statSync(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error(`${label}_permissions_unsafe`);
  return fs.readFileSync(target, "utf8");
}

function identityCandidate({ ca, certFile, keyFile, serviceId, slot }) {
  const cert = fs.readFileSync(path.resolve(certFile), "utf8");
  const key = privateKey(keyFile, `collector_mtls_${slot}_private_key`);
  const [certificate] = certificateBundle(cert);
  if (!certificate) throw new Error("collector_mtls_certificate_invalid");
  if (!hasIdentity(certificate, serviceId))
    throw new Error("collector_mtls_service_identity_mismatch");
  if (!certificateChainsToCA(certificate, ca))
    throw new Error("collector_mtls_ca_verification_failed");
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  const now = Date.now();
  if (!Number.isFinite(validFrom) || validFrom > now + 60_000)
    throw new Error("collector_mtls_certificate_not_yet_valid");
  if (!Number.isFinite(validTo) || validTo <= now)
    throw new Error("collector_mtls_certificate_expired");
  const minimumRemaining = Math.max(
    60_000,
    Number(process.env.ATHENA_MTLS_MIN_REMAINING_MS || 5 * 60 * 1000)
  );
  if (validTo - now < minimumRemaining)
    throw new Error("collector_mtls_certificate_expiring");
  if (
    certificate.publicKey
      .export({ format: "der", type: "spki" })
      .compare(
        crypto.createPublicKey(key).export({ format: "der", type: "spki" })
      ) !== 0
  )
    throw new Error("collector_mtls_private_key_mismatch");
  return { cert, key, certificate, validTo, slot };
}

function collectorServerIdentity({
  required = process.env.ATHENA_SERVICE_MTLS_REQUIRED === "true",
} = {}) {
  const caFile = String(process.env.COLLECTOR_MTLS_CA_FILE || "").trim();
  const certFile = String(process.env.COLLECTOR_MTLS_CERT_FILE || "").trim();
  const keyFile = String(process.env.COLLECTOR_MTLS_KEY_FILE || "").trim();
  const nextCertFile = String(
    process.env.COLLECTOR_MTLS_NEXT_CERT_FILE || ""
  ).trim();
  const nextKeyFile = String(
    process.env.COLLECTOR_MTLS_NEXT_KEY_FILE || ""
  ).trim();
  if (!caFile || !certFile || !keyFile) {
    if (!required) return null;
    throw new Error("collector_mtls_identity_files_missing");
  }
  const ca = fs.readFileSync(path.resolve(caFile), "utf8");
  if (!certificateBundle(ca).length)
    throw new Error("collector_mtls_ca_invalid");
  if (Boolean(nextCertFile) !== Boolean(nextKeyFile))
    throw new Error("collector_mtls_next_pair_incomplete");
  const serviceId = expectedIdentity("collector");
  const primary = identityCandidate({
    ca,
    certFile,
    keyFile,
    serviceId,
    slot: "primary",
  });
  const next = nextCertFile
    ? identityCandidate({
        ca,
        certFile: nextCertFile,
        keyFile: nextKeyFile,
        serviceId,
        slot: "next",
      })
    : null;
  const switchWindow = Math.max(
    5 * 60 * 1000,
    Number(process.env.ATHENA_MTLS_ROTATION_SWITCH_MS || 24 * 60 * 60 * 1000)
  );
  const selected =
    next && primary.validTo - Date.now() <= switchWindow ? next : primary;
  return {
    ca,
    cert: selected.cert,
    key: selected.key,
    serviceId,
    allowedClientIds: String(
      process.env.COLLECTOR_MTLS_ALLOWED_CLIENT_IDS || expectedIdentity("api")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    fingerprint256: selected.certificate.fingerprint256,
    serialNumber: selected.certificate.serialNumber,
    validFrom: selected.certificate.validFrom,
    validTo: selected.certificate.validTo,
    certificateSlot: selected.slot,
  };
}

function authorizePeer(request, identity) {
  if (!identity) return true;
  if (!request.client.authorized) return false;
  const certificate = request.socket.getPeerX509Certificate?.();
  return Boolean(
    certificate &&
      identity.allowedClientIds.some((serviceId) =>
        hasIdentity(certificate, serviceId)
      )
  );
}

module.exports = {
  authorizePeer,
  certificateBundle,
  certificateChainsToCA,
  collectorServerIdentity,
  expectedIdentity,
  hasIdentity,
};
