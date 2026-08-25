const crypto = require("crypto");
const prisma = require("../utils/prisma");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const {
  parseJson,
  publicDevice,
  publicJob,
  publicLease,
  sha256,
  stableJson,
} = require("../utils/localRuntime/contracts");

function ticketHash(token) {
  return sha256(`athena-local-runtime-pairing:${String(token || "")}`);
}

const LocalRuntime = {
  async issuePairingTicket({
    ownerUserId,
    ownerAuthUserId,
    clientId = null,
    ttlMs = 5 * 60_000,
  } = {}) {
    const token = `lrp_${crypto.randomBytes(32).toString("base64url")}`;
    try {
      const row = await prisma.local_runtime_pairing_tickets.create({
        data: {
          id: crypto.randomUUID(),
          ownerUserId: Number(ownerUserId),
          ownerAuthUserId: String(ownerAuthUserId),
          clientId: clientId ? String(clientId) : null,
          tokenHash: ticketHash(token),
          expiresAt: new Date(
            Date.now() +
              Math.min(Math.max(Number(ttlMs) || 0, 60_000), 10 * 60_000)
          ),
        },
      });
      return { token, expiresAt: row.expiresAt };
    } catch (error) {
      throwModelDataAccessError("localRuntime.issuePairingTicket", error);
    }
  },

  async pairDevice({
    token,
    name,
    platform = "macos",
    version = null,
    publicKeyPem,
    keyAlgorithm = "p256",
    capabilities = {},
    permissions = {},
  } = {}) {
    try {
      return await prisma.$transaction(async (tx) => {
        const ticket = await tx.local_runtime_pairing_tickets.findUnique({
          where: { tokenHash: ticketHash(token) },
        });
        if (
          !ticket ||
          ticket.status !== "pending" ||
          ticket.expiresAt <= new Date()
        )
          throw Object.assign(
            new Error("local_runtime_pairing_ticket_invalid"),
            { code: "local_runtime_pairing_ticket_invalid", httpStatus: 401 }
          );
        const device = await tx.local_runtime_devices.create({
          data: {
            id: crypto.randomUUID(),
            ownerUserId: ticket.ownerUserId,
            ownerAuthUserId: ticket.ownerAuthUserId,
            clientId: ticket.clientId,
            name: String(name || "Mac").slice(0, 120),
            platform: String(platform || "macos").slice(0, 32),
            version: version ? String(version).slice(0, 64) : null,
            publicKeyPem: String(publicKeyPem || "").slice(0, 16_384),
            keyAlgorithm: String(keyAlgorithm || "p256").slice(0, 32),
            capabilitiesJson: stableJson(capabilities || {}),
            permissionsJson: stableJson(permissions || {}),
            status: "offline",
          },
        });
        await tx.local_runtime_pairing_tickets.update({
          where: { id: ticket.id },
          data: { status: "consumed", consumedAt: new Date() },
        });
        return device;
      });
    } catch (error) {
      if (error?.code === "local_runtime_pairing_ticket_invalid") throw error;
      throwModelDataAccessError("localRuntime.pairDevice", error);
    }
  },

  async device({ ownerUserId = null, deviceId } = {}) {
    try {
      return await prisma.local_runtime_devices.findFirst({
        where: {
          id: String(deviceId),
          ...(ownerUserId ? { ownerUserId: Number(ownerUserId) } : {}),
        },
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.device", error);
    }
  },

  async listDevices({ ownerUserId } = {}) {
    try {
      return await prisma.local_runtime_devices.findMany({
        where: { ownerUserId: Number(ownerUserId), revokedAt: null },
        orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.listDevices", error);
    }
  },

  async heartbeatDevice({
    deviceId,
    connectionId,
    version = null,
    capabilities = null,
    permissions = null,
    status = "online",
  } = {}) {
    try {
      return await prisma.local_runtime_devices.update({
        where: { id: String(deviceId) },
        data: {
          connectionId: connectionId || null,
          version: version ? String(version).slice(0, 64) : undefined,
          capabilitiesJson: capabilities ? stableJson(capabilities) : undefined,
          permissionsJson: permissions ? stableJson(permissions) : undefined,
          status,
          lastSeenAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.heartbeatDevice", error);
    }
  },

  async revokeDevice({ ownerUserId, deviceId } = {}) {
    try {
      return await prisma.$transaction(async (tx) => {
        const now = new Date();
        const updated = await tx.local_runtime_devices.updateMany({
          where: {
            id: String(deviceId),
            ownerUserId: Number(ownerUserId),
            revokedAt: null,
          },
          data: { status: "revoked", revokedAt: now, connectionId: null },
        });
        await tx.local_runtime_leases.updateMany({
          where: {
            deviceId: String(deviceId),
            ownerUserId: Number(ownerUserId),
            status: "active",
          },
          data: { status: "revoked", revokedAt: now },
        });
        await tx.local_runtime_jobs.updateMany({
          where: {
            deviceId: String(deviceId),
            ownerUserId: Number(ownerUserId),
            status: { in: ["queued", "waiting_for_device", "running"] },
          },
          data: {
            status: "cancelled",
            reasonCode: "local_runtime_device_revoked",
            completedAt: now,
          },
        });
        return updated.count > 0;
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.revokeDevice", error);
    }
  },

  async createLease({
    ownerUserId,
    ownerAuthUserId,
    deviceId,
    capabilities,
    allowedRoots = [],
    allowedApps = [],
    ttlMs = 24 * 60 * 60_000,
  } = {}) {
    try {
      const device = await prisma.local_runtime_devices.findFirst({
        where: {
          id: String(deviceId),
          ownerUserId: Number(ownerUserId),
          ownerAuthUserId: String(ownerAuthUserId),
          revokedAt: null,
        },
      });
      if (!device)
        throw Object.assign(new Error("local_runtime_device_not_found"), {
          code: "local_runtime_device_not_found",
          httpStatus: 404,
        });
      await prisma.local_runtime_leases.updateMany({
        where: {
          deviceId: device.id,
          ownerUserId: Number(ownerUserId),
          status: "active",
        },
        data: { status: "superseded", revokedAt: new Date() },
      });
      return await prisma.local_runtime_leases.create({
        data: {
          id: crypto.randomUUID(),
          deviceId: device.id,
          ownerUserId: Number(ownerUserId),
          ownerAuthUserId: String(ownerAuthUserId),
          capabilitiesJson: stableJson(capabilities || []),
          allowedRootsJson: stableJson(allowedRoots || []),
          allowedAppsJson: stableJson(allowedApps || []),
          expiresAt: new Date(
            Date.now() +
              Math.min(Math.max(Number(ttlMs) || 0, 60_000), 24 * 60 * 60_000)
          ),
        },
      });
    } catch (error) {
      if (error?.code === "local_runtime_device_not_found") throw error;
      throwModelDataAccessError("localRuntime.createLease", error);
    }
  },

  async activeLease({ ownerUserId, deviceId } = {}) {
    try {
      return await prisma.local_runtime_leases.findFirst({
        where: {
          ownerUserId: Number(ownerUserId),
          deviceId: String(deviceId),
          status: "active",
          expiresAt: { gt: new Date() },
        },
        orderBy: { issuedAt: "desc" },
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.activeLease", error);
    }
  },

  async listLeases({ ownerUserId, deviceId = null } = {}) {
    try {
      return await prisma.local_runtime_leases.findMany({
        where: {
          ownerUserId: Number(ownerUserId),
          ...(deviceId ? { deviceId: String(deviceId) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.listLeases", error);
    }
  },

  async revokeLease({ ownerUserId, leaseId } = {}) {
    try {
      const result = await prisma.local_runtime_leases.updateMany({
        where: {
          id: String(leaseId),
          ownerUserId: Number(ownerUserId),
          status: "active",
        },
        data: { status: "revoked", revokedAt: new Date() },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError("localRuntime.revokeLease", error);
    }
  },

  async createJob(input = {}) {
    const ownerUserId = Number(input.ownerUserId);
    const idempotencyKey = String(
      input.idempotencyKey || crypto.randomUUID()
    ).slice(0, 256);
    try {
      const existing = await prisma.local_runtime_jobs.findUnique({
        where: { ownerUserId_idempotencyKey: { ownerUserId, idempotencyKey } },
      });
      if (existing) return { row: existing, wasCreated: false };
      const payloadJson = stableJson(input.payload || {});
      const row = await prisma.local_runtime_jobs.create({
        data: {
          id: crypto.randomUUID(),
          ownerUserId,
          ownerAuthUserId: String(input.ownerAuthUserId),
          deviceId: String(input.deviceId),
          leaseId: String(input.leaseId),
          responseId: input.responseId ? String(input.responseId) : null,
          toolInvocationId: input.toolInvocationId
            ? String(input.toolInvocationId)
            : null,
          toolName: String(input.toolName),
          riskLevel: String(input.riskLevel || "L0"),
          stepUpApproved: input.stepUpApproved === true,
          priority: String(input.priority || "P2"),
          executionMode:
            input.executionMode === "background" ? "background" : "interactive",
          idempotencyKey,
          argumentHash: sha256(input.payload || {}),
          payloadJson,
          deadlineAt: new Date(input.deadlineAt || Date.now() + 10 * 60_000),
        },
      });
      return { row, wasCreated: true };
    } catch (error) {
      throwModelDataAccessError("localRuntime.createJob", error);
    }
  },

  async job({ ownerUserId = null, jobId } = {}) {
    try {
      return await prisma.local_runtime_jobs.findFirst({
        where: {
          id: String(jobId),
          ...(ownerUserId ? { ownerUserId: Number(ownerUserId) } : {}),
        },
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.job", error);
    }
  },

  async pendingJobs({ deviceId, limit = 20 } = {}) {
    try {
      return await prisma.local_runtime_jobs.findMany({
        where: {
          deviceId: String(deviceId),
          status: { in: ["queued", "waiting_for_device"] },
          deadlineAt: { gt: new Date() },
        },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: Math.min(50, Math.max(1, Number(limit) || 20)),
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.pendingJobs", error);
    }
  },

  async markDeviceJobsWaiting({ deviceId } = {}) {
    try {
      return await prisma.local_runtime_jobs.updateMany({
        where: {
          deviceId: String(deviceId),
          status: "running",
          deadlineAt: { gt: new Date() },
        },
        data: {
          status: "waiting_for_device",
          reasonCode: "local_runtime_device_disconnected",
        },
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.markDeviceJobsWaiting", error);
    }
  },

  async listJobs({ ownerUserId, deviceId = null, limit = 50 } = {}) {
    try {
      return await prisma.local_runtime_jobs.findMany({
        where: {
          ownerUserId: Number(ownerUserId),
          ...(deviceId ? { deviceId: String(deviceId) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(100, Math.max(1, Number(limit) || 50)),
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.listJobs", error);
    }
  },

  async transitionJob({
    jobId,
    status,
    reasonCode = null,
    result = undefined,
  } = {}) {
    const terminal = [
      "completed",
      "failed",
      "cancelled",
      "denied",
      "expired",
    ].includes(status);
    try {
      return await prisma.local_runtime_jobs.update({
        where: { id: String(jobId) },
        data: {
          status,
          reasonCode,
          startedAt: status === "running" ? new Date() : undefined,
          completedAt: terminal ? new Date() : undefined,
          resultJson: result === undefined ? undefined : stableJson(result),
          resultHash: result === undefined ? undefined : sha256(result),
        },
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.transitionJob", error);
    }
  },

  async appendEvent({ jobId, type, payload = {} } = {}) {
    try {
      return await prisma.$transaction(async (tx) => {
        const job = await tx.local_runtime_jobs.update({
          where: { id: String(jobId) },
          data: { lastSequence: { increment: 1 } },
        });
        const event = await tx.local_runtime_job_events.create({
          data: {
            id: crypto.randomUUID(),
            jobId: job.id,
            sequence: job.lastSequence,
            type: String(type).slice(0, 120),
            payloadJson: stableJson(payload || {}),
          },
        });
        return {
          ...event,
          payload: parseJson(event.payloadJson, {}),
          payloadJson: undefined,
        };
      });
    } catch (error) {
      throwModelDataAccessError("localRuntime.appendEvent", error);
    }
  },

  async jobEvents({ jobId, afterSequence = 0, limit = 200 } = {}) {
    try {
      const rows = await prisma.local_runtime_job_events.findMany({
        where: {
          jobId: String(jobId),
          sequence: { gt: Math.max(0, Number(afterSequence) || 0) },
        },
        orderBy: { sequence: "asc" },
        take: Math.min(500, Math.max(1, Number(limit) || 200)),
      });
      return rows.map((row) => ({
        ...row,
        payload: parseJson(row.payloadJson, {}),
        payloadJson: undefined,
      }));
    } catch (error) {
      throwModelDataAccessError("localRuntime.jobEvents", error);
    }
  },

  publicDevice,
  publicJob,
  publicLease,
};

module.exports = { LocalRuntime };
