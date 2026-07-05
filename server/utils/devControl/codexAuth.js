const crypto = require("crypto");

function devControlEnabled() {
  return process.env.ATHENA_DEV_CONTROL_ENABLED === "true";
}

function agreementKey() {
  return String(process.env.ATHENA_CODEX_AGREEMENT_KEY || "");
}

function timingSafeEqual(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length)
    return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyAgreementKey(candidate = "") {
  const expected = agreementKey();
  return !!expected && timingSafeEqual(candidate, expected);
}

module.exports = {
  devControlEnabled,
  verifyAgreementKey,
};
