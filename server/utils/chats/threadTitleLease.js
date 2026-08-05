const crypto = require("crypto");

function secret(env = process.env) {
  const value =
    env.ATHENA_THREAD_TITLE_LEASE_SECRET ||
    env.SIG_KEY ||
    env.JWT_SECRET ||
    env.AUTH_TOKEN;
  if (!value) throw new Error("thread_title_lease_secret_missing");
  return String(value);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signature(payload, env = process.env) {
  return crypto
    .createHmac("sha256", secret(env))
    .update(payload)
    .digest("base64url");
}

function issueThreadTitleLease(claims = {}, env = process.env) {
  const payload = encode({
    ...claims,
    exp: Date.now() + Number(env.THREAD_TITLE_LEASE_TTL_MS || 60_000),
    nonce: crypto.randomUUID(),
  });
  return `${payload}.${signature(payload, env)}`;
}

function verifyThreadTitleLease(token = "", env = process.env) {
  const [payload, provided] = String(token).split(".");
  if (!payload || !provided) throw new Error("thread_title_lease_invalid");
  const expected = signature(payload, env);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  )
    throw new Error("thread_title_lease_invalid");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (Number(claims.exp || 0) <= Date.now())
    throw new Error("thread_title_lease_expired");
  return claims;
}

module.exports = { issueThreadTitleLease, verifyThreadTitleLease };
