const bcrypt = require("bcryptjs");
const { lazyDataAccessFacade } = require("./dataAccess/lazyFacade");
const EmailVerificationRateLimit =
  lazyDataAccessFacade("adminSystem").emailVerificationRateLimit;

const WINDOW_MS = 15 * 60 * 1_000;
const PURPOSE = "credential_login";
const DUMMY_HASH_PROMISE = bcrypt.hash(
  "athena-login-dummy-password-never-valid",
  10
);

function normalizeIdentifier(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 320);
}

function bucketSpecs({ ip, identifier }) {
  const normalizedIp = String(ip || "unknown")
    .trim()
    .slice(0, 128);
  const normalizedIdentifier = normalizeIdentifier(identifier) || "unknown";
  return [
    { bucketType: "ip", value: normalizedIp, limit: 30 },
    {
      bucketType: "identifier",
      value: normalizedIdentifier,
      limit: 10,
    },
    {
      bucketType: "ip_identifier",
      value: `${normalizedIp}:${normalizedIdentifier}`,
      limit: 5,
    },
  ];
}

async function checkLoginAllowed(context) {
  const statuses = await Promise.all(
    bucketSpecs(context).map((spec) =>
      EmailVerificationRateLimit.status({
        ...spec,
        purpose: PURPOSE,
        windowMs: WINDOW_MS,
      })
    )
  );
  const blocked = statuses.filter((status) => status.blocked);
  return {
    allowed: blocked.length === 0,
    retryAfterSeconds: blocked.reduce(
      (max, status) => Math.max(max, status.retryAfterSeconds),
      0
    ),
  };
}

async function recordLoginFailure(context) {
  await Promise.all(
    bucketSpecs(context).map((spec) =>
      EmailVerificationRateLimit.hit({
        ...spec,
        purpose: PURPOSE,
        windowMs: WINDOW_MS,
      })
    )
  );
  return checkLoginAllowed(context);
}

async function clearLoginSuccess(context) {
  const [, identifier, pair] = bucketSpecs(context);
  await Promise.all(
    [identifier, pair].map((spec) =>
      EmailVerificationRateLimit.clear({ ...spec, purpose: PURPOSE })
    )
  );
}

async function dummyPasswordCompare(password = "") {
  return bcrypt.compare(String(password), await DUMMY_HASH_PROMISE);
}

function sendLoginRateLimited(response, retryAfterSeconds) {
  const retryAfter = Math.max(1, Number(retryAfterSeconds) || 1);
  response.set("Retry-After", String(retryAfter));
  return response.status(429).json({
    valid: false,
    token: null,
    error: "login_rate_limited",
    message: "Too many login attempts. Please try again later.",
    retryAfter,
  });
}

module.exports = {
  WINDOW_MS,
  checkLoginAllowed,
  clearLoginSuccess,
  dummyPasswordCompare,
  normalizeIdentifier,
  recordLoginFailure,
  sendLoginRateLimited,
};
