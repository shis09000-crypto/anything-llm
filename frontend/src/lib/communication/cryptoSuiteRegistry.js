export const CRYPTO_SUITE_PURPOSES = Object.freeze({
  requestSignature: "request-signature",
  deviceKey: "device-key",
});

export const CRYPTO_SUITE_IDS = Object.freeze({
  requestHmacV1: "v1",
  requestDeviceP256V2: "v2-device-p256",
  deviceP256WebCryptoV1: "p256-v1",
});

const suites = Object.freeze([
  Object.freeze({
    suiteId: CRYPTO_SUITE_IDS.requestDeviceP256V2,
    purpose: CRYPTO_SUITE_PURPOSES.requestSignature,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "jwk",
    signatureEncoding: "ieee-p1363-base64url",
    minimumClientVersion: "0.0.0",
    status: "active",
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    protocolPrefix: "ATHENA-DEVICE-SIGN-V1",
  }),
  Object.freeze({
    suiteId: CRYPTO_SUITE_IDS.requestHmacV1,
    purpose: CRYPTO_SUITE_PURPOSES.requestSignature,
    classicalAlgorithm: "HMAC-SHA256",
    pqAlgorithm: null,
    parameterSet: "SHA-256/256-bit-key",
    keyEncoding: "raw-base64url",
    signatureEncoding: "base64url",
    minimumClientVersion: "0.0.0",
    status: "compatibility",
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    protocolPrefix: "ATHENA-SIGN-V1",
  }),
  Object.freeze({
    suiteId: CRYPTO_SUITE_IDS.deviceP256WebCryptoV1,
    purpose: CRYPTO_SUITE_PURPOSES.deviceKey,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "jwk",
    signatureEncoding: "ieee-p1363-base64url",
    minimumClientVersion: "0.0.0",
    status: "compatibility",
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
  }),
]);

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : [0, 0, 0];
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function suiteAvailable(
  suite,
  { clientVersion = "0.0.0", now = Date.now() } = {}
) {
  if (!suite || !["active", "compatibility"].includes(suite.status)) {
    return false;
  }
  if (
    suite.minimumClientVersion &&
    compareVersions(clientVersion, suite.minimumClientVersion) < 0
  ) {
    return false;
  }
  if (suite.notBefore && now < Date.parse(suite.notBefore)) return false;
  if (suite.deprecatedAfter && now >= Date.parse(suite.deprecatedAfter)) {
    return false;
  }
  return true;
}

export function cryptoSuite(suiteId, purpose, availability = {}) {
  return (
    suites.find(
      (suite) =>
        suite.suiteId === suiteId &&
        (!purpose || suite.purpose === purpose) &&
        suiteAvailable(suite, availability)
    ) || null
  );
}

export function preferredCryptoSuite(purpose, availability = {}) {
  return (
    suites.find(
      (suite) =>
        suite.purpose === purpose &&
        suite.status === "active" &&
        suiteAvailable(suite, availability)
    ) || null
  );
}

export const WEB_CRYPTO_SUITES = suites;
