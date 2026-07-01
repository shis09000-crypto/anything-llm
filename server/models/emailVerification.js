const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const authPrisma = require("../utils/authPrisma");

function prismaErrorLabel(error) {
  return error?.code || error?.name || "UnknownPrismaError";
}

const CODE_HMAC_PREFIX = "hmac-sha256:v1:";
const GRANT_HASH_PREFIX = "grant-hmac-sha256:v1:";
const RATE_LIMIT_HASH_PREFIX = "rl-hmac-sha256:v1:";

function verificationHmacSecret() {
  const secret =
    process.env.EMAIL_VERIFICATION_HMAC_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SIG_KEY;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "EMAIL_VERIFICATION_HMAC_SECRET or JWT_SECRET is required."
    );
  return "athena-email-verification-dev-only-secret";
}

function hmacCode(code = "") {
  return `${CODE_HMAC_PREFIX}${crypto
    .createHmac("sha256", verificationHmacSecret())
    .update(String(code))
    .digest("base64url")}`;
}

function plainGrantToken() {
  return `evg_${crypto.randomBytes(32).toString("base64url")}`;
}

function hashGrantToken(token = "") {
  return `${GRANT_HASH_PREFIX}${crypto
    .createHmac("sha256", verificationHmacSecret())
    .update(String(token))
    .digest("base64url")}`;
}

function hashRateLimitBucket({ bucketType, purpose, value }) {
  return `${RATE_LIMIT_HASH_PREFIX}${crypto
    .createHmac("sha256", verificationHmacSecret())
    .update(
      [bucketType || "unknown", purpose || "unknown", String(value || "")]
        .join(":")
        .toLowerCase()
    )
    .digest("base64url")}`;
}

function timingSafeEqualString(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyStoredCode(code = "", codeHash = "") {
  if (!codeHash) return false;
  if (String(codeHash).startsWith(CODE_HMAC_PREFIX)) {
    return timingSafeEqualString(hmacCode(code), codeHash);
  }

  // Backward compatibility for in-flight bcrypt verification codes.
  try {
    return bcrypt.compareSync(String(code), codeHash);
  } catch {
    return false;
  }
}

const EmailVerificationCode = {
  tablename: "email_verification_codes",
  maxAttempts: 5,
  codeExpiryMs: 600_000,
  resendCooldownMs: 60_000,

  userIdWhere: function (userId) {
    return userId === null || userId === undefined
      ? { user_id: null }
      : { user_id: Number(userId) };
  },

  calcExpiry: function () {
    return new Date(Date.now() + this.codeExpiryMs);
  },

  create: async function ({
    userId,
    email,
    purpose,
    code,
    requestIp,
    clientId = null,
    deviceId = null,
    sessionId = null,
  }) {
    try {
      const codeHash = hmacCode(code);
      const verification = await authPrisma.email_verification_codes.create({
        data: {
          user_id:
            userId === null || userId === undefined ? null : Number(userId),
          challenge_id: crypto.randomUUID(),
          email,
          purpose,
          code_hash: codeHash,
          expiresAt: this.calcExpiry(),
          request_ip: requestIp || null,
          client_id: clientId || null,
          device_id: deviceId || null,
          session_id: sessionId || null,
        },
      });
      return { verification, error: null };
    } catch (error) {
      console.error(
        "FAILED TO CREATE EMAIL VERIFICATION CODE.",
        prismaErrorLabel(error)
      );
      return { verification: null, error: error.message };
    }
  },

  verifyCode: function (code, codeHash) {
    return verifyStoredCode(code, codeHash);
  },

  latest: async function ({ userId, email = null, purpose }) {
    try {
      return await authPrisma.email_verification_codes.findFirst({
        where: {
          ...this.userIdWhere(userId),
          purpose,
          ...(email ? { email } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      console.error(
        "FAILED TO FIND EMAIL VERIFICATION CODE.",
        prismaErrorLabel(error)
      );
      return null;
    }
  },

  findByChallenge: async function ({
    challengeId,
    userId,
    email = null,
    purpose,
  }) {
    if (!challengeId) return null;
    try {
      const verification = await authPrisma.email_verification_codes.findUnique(
        {
          where: { challenge_id: String(challengeId) },
        }
      );
      if (!verification) return null;

      const expectedUserId =
        userId === null || userId === undefined ? null : Number(userId);
      if (verification.user_id !== expectedUserId) return null;
      if (purpose && verification.purpose !== purpose) return null;
      if (email && verification.email !== email) return null;
      return verification;
    } catch (error) {
      console.error(
        "FAILED TO FIND EMAIL VERIFICATION CHALLENGE.",
        prismaErrorLabel(error)
      );
      return null;
    }
  },

  latestPendingForUser: async function ({ userId, purpose }) {
    try {
      return await authPrisma.email_verification_codes.findFirst({
        where: {
          user_id: Number(userId),
          purpose,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      console.error(
        "FAILED TO FIND PENDING EMAIL VERIFICATION.",
        prismaErrorLabel(error)
      );
      return null;
    }
  },

  incrementAttempts: async function (id) {
    try {
      await authPrisma.email_verification_codes.update({
        where: { id: Number(id) },
        data: { attempts: { increment: 1 } },
      });
      return true;
    } catch (error) {
      console.error(
        "FAILED TO INCREMENT EMAIL VERIFICATION ATTEMPTS.",
        prismaErrorLabel(error)
      );
      return false;
    }
  },

  consume: async function (id) {
    try {
      const result = await authPrisma.email_verification_codes.updateMany({
        where: {
          id: Number(id),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      return result.count === 1;
    } catch (error) {
      console.error(
        "FAILED TO CONSUME EMAIL VERIFICATION CODE.",
        prismaErrorLabel(error)
      );
      return false;
    }
  },

  expireOpenCodes: async function ({ userId, purpose, email = null }) {
    try {
      await authPrisma.email_verification_codes.updateMany({
        where: {
          ...this.userIdWhere(userId),
          purpose,
          ...(email ? { email } : {}),
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
      return true;
    } catch (error) {
      console.error(
        "FAILED TO EXPIRE EMAIL VERIFICATION CODES.",
        prismaErrorLabel(error)
      );
      return false;
    }
  },
};

const EmailVerificationGrant = {
  tablename: "email_verification_grants",
  grantExpiryMs: 600_000,

  calcExpiry: function () {
    return new Date(Date.now() + this.grantExpiryMs);
  },

  create: async function ({
    userId,
    purpose,
    scope,
    email,
    challengeId = null,
    clientId = null,
    deviceId = null,
    sessionId = null,
  }) {
    try {
      const numericUserId = Number(userId);
      if (!Number.isInteger(numericUserId) || numericUserId < 1)
        return { grant: null, error: "Invalid grant user." };

      const token = plainGrantToken();
      const grant = await authPrisma.email_verification_grants.create({
        data: {
          grant_id: crypto.randomUUID(),
          user_id: numericUserId,
          purpose,
          scope,
          grant_hash: hashGrantToken(token),
          challenge_id: challengeId || null,
          email,
          client_id: clientId || null,
          device_id: deviceId || null,
          session_id: sessionId || null,
          expiresAt: this.calcExpiry(),
        },
      });
      return { grant: { ...grant, token }, error: null };
    } catch (error) {
      console.error(
        "FAILED TO CREATE EMAIL VERIFICATION GRANT.",
        prismaErrorLabel(error)
      );
      return { grant: null, error: error.message };
    }
  },

  findValid: async function ({ token, scope = null }) {
    try {
      const grant = await authPrisma.email_verification_grants.findUnique({
        where: { grant_hash: hashGrantToken(token) },
      });
      if (!grant) return null;
      if (scope && grant.scope !== scope) return null;
      if (grant.consumedAt) return null;
      if (grant.expiresAt < new Date()) return null;
      return grant;
    } catch (error) {
      console.error(
        "FAILED TO FIND EMAIL VERIFICATION GRANT.",
        prismaErrorLabel(error)
      );
      return null;
    }
  },

  consume: async function (id) {
    try {
      const result = await authPrisma.email_verification_grants.updateMany({
        where: {
          id: Number(id),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      return result.count === 1;
    } catch (error) {
      console.error(
        "FAILED TO CONSUME EMAIL VERIFICATION GRANT.",
        prismaErrorLabel(error)
      );
      return false;
    }
  },

  consumeMany: async function ({ userId, scope = null }) {
    try {
      await authPrisma.email_verification_grants.updateMany({
        where: {
          user_id: Number(userId),
          ...(scope ? { scope } : {}),
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
      return true;
    } catch (error) {
      console.error(
        "FAILED TO CONSUME EMAIL VERIFICATION GRANTS.",
        prismaErrorLabel(error)
      );
      return false;
    }
  },
};

const EmailVerificationRateLimit = {
  tablename: "email_verification_rate_limits",

  bucketHash: function ({ bucketType, purpose, value }) {
    return hashRateLimitBucket({ bucketType, purpose, value });
  },

  hit: async function ({
    bucketType,
    purpose,
    value,
    limit,
    windowMs = 60 * 60 * 1000,
  }) {
    if (!value || !limit || limit < 1) return false;
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
    const bucketHash = this.bucketHash({ bucketType, purpose, value });
    let bucket = await authPrisma.email_verification_rate_limits.findUnique({
      where: { bucket_hash: bucketHash },
    });

    if (bucket?.blockedUntil && bucket.blockedUntil > now) return true;
    if (!bucket) {
      try {
        await authPrisma.email_verification_rate_limits.create({
          data: {
            bucket_hash: bucketHash,
            bucket_type: bucketType,
            purpose,
            window_start: windowStart,
            count: 1,
            updatedAt: now,
          },
        });
        return false;
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        bucket = await authPrisma.email_verification_rate_limits.findUnique({
          where: { bucket_hash: bucketHash },
        });
        if (!bucket) throw error;
      }
    }

    if (bucket.window_start < windowStart) {
      await authPrisma.email_verification_rate_limits.update({
        where: { bucket_hash: bucketHash },
        data: {
          window_start: windowStart,
          count: 1,
          blockedUntil: null,
          updatedAt: now,
        },
      });
      return false;
    }

    if (bucket.count >= limit) {
      await authPrisma.email_verification_rate_limits.update({
        where: { bucket_hash: bucketHash },
        data: {
          blockedUntil: new Date(windowStart.getTime() + windowMs),
          updatedAt: now,
        },
      });
      return true;
    }

    await authPrisma.email_verification_rate_limits.update({
      where: { bucket_hash: bucketHash },
      data: { count: { increment: 1 }, updatedAt: now },
    });
    return false;
  },
};

module.exports = {
  EmailVerificationCode,
  EmailVerificationGrant,
  EmailVerificationRateLimit,
  _private: {
    hmacCode,
    verifyStoredCode,
    hashGrantToken,
    plainGrantToken,
    hashRateLimitBucket,
  },
};
