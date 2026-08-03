const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const { redactLogObject } = require("../utils/security/redaction");
const {
  appendSecurityAuditDurably,
  isSecurityRelevantEvent,
} = require("../utils/security/auditLedger");
const { currentCorrelation } = require("../utils/observability/context");

const EventLogs = {
  logEvent: async function (event, metadata = {}, userId = null) {
    const occurredAt = new Date();
    let eventLog = null;
    let productLogError = null;
    const safeMetadata =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? redactLogObject(metadata)
        : metadata;
    const {
      appendIdentityEventViaIdentity,
      remoteIdentityOperationsEnabled,
    } = require("../utils/authz/identityOperationsClient");
    if (remoteIdentityOperationsEnabled()) {
      try {
        const remote = await appendIdentityEventViaIdentity({
          event,
          metadata: safeMetadata,
          userId,
          occurredAt: occurredAt.toISOString(),
          idempotencyKey:
            metadata?.eventId ||
            metadata?.requestId ||
            `${event}:${occurredAt.getTime()}`,
        });
        return {
          eventLog: remote?.eventLog || null,
          securityAudit: remote?.securityAudit || null,
          message: null,
        };
      } catch (error) {
        console.error(
          `\x1b[31m[Event Logging Failed]\x1b[0m - ${event}`,
          error.message
        );
        return { eventLog: null, securityAudit: null, message: error.message };
      }
    }
    try {
      eventLog = await prisma.event_logs.create({
        data: {
          event,
          metadata: safeMetadata ? JSON.stringify(safeMetadata) : null,
          userId: userId ? Number(userId) : null,
          occurredAt,
        },
      });
      console.log(`\x1b[32m[Event Logged]\x1b[0m - ${event}`);
    } catch (error) {
      productLogError = error;
      console.error(
        `\x1b[31m[Event Logging Failed]\x1b[0m - ${event}`,
        error.message
      );
    }
    let securityAudit = null;
    if (isSecurityRelevantEvent(event)) {
      const correlation = currentCorrelation();
      securityAudit = await appendSecurityAuditDurably({
        event,
        metadata: safeMetadata,
        userId,
        requestId: metadata?.requestId || correlation?.requestId || null,
        traceId: metadata?.traceId || correlation?.traceId || null,
        occurredAt,
      });
    }
    return {
      eventLog,
      securityAudit,
      message: productLogError?.message || null,
    };
  },

  getByEvent: async function (event, limit = null, orderBy = null) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: { event },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      throwModelDataAccessError("eventLogs.getByEvent", error);
    }
  },

  getByUserId: async function (userId, limit = null, orderBy = null) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: { userId },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      throwModelDataAccessError("eventLogs.getByUserId", error);
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      throwModelDataAccessError("eventLogs.where", error);
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    const { User } = require("./user");

    try {
      const results = await this.where(clause, limit, orderBy, offset);

      for (const res of results) {
        const user = res.userId ? await User.get({ id: res.userId }) : null;
        res.user = user
          ? { username: user.username }
          : { username: "unknown user" };
      }

      return results;
    } catch (error) {
      throwModelDataAccessError("eventLogs.whereWithData", error);
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.event_logs.count({
        where: clause,
      });
      return count;
    } catch (error) {
      throwModelDataAccessError("eventLogs.count", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.event_logs.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      throwModelDataAccessError("eventLogs.delete", error);
    }
  },
};

module.exports = { EventLogs };
