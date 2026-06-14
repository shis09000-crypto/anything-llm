const bcrypt = require("bcryptjs");
const authPrisma = require("../utils/authPrisma");

function prismaErrorLabel(error) {
  return error?.code || error?.name || "UnknownPrismaError";
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

  create: async function ({ userId, email, purpose, code, requestIp }) {
    try {
      const codeHash = bcrypt.hashSync(String(code), 10);
      const verification = await authPrisma.email_verification_codes.create({
        data: {
          user_id:
            userId === null || userId === undefined ? null : Number(userId),
          email,
          purpose,
          code_hash: codeHash,
          expiresAt: this.calcExpiry(),
          request_ip: requestIp || null,
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

module.exports = { EmailVerificationCode };
