const crypto = require("crypto");
const fs = require("fs");
const prisma = require("../utils/prisma");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const { compactUrl, sha256 } = require("../utils/browserPlane/contracts");
const { ContentObject } = require("./contentObject");

function json(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function publicWorkspace(row) {
  if (!row) return null;
  return { ...row, state: json(row.stateJson, {}), stateJson: undefined };
}

function safePageUrl(value) {
  const compacted = compactUrl(value);
  if (!compacted) return null;
  const url = new URL(compacted);
  return { urlWithoutQuery: compacted, origin: url.origin };
}

const BrowserPlane = {
  async ensureProfile({ userId, profileId, executionLocation = "cloud" } = {}) {
    try {
      return await prisma.browser_profiles.upsert({
        where: {
          ownerUserId_profileId: { ownerUserId: Number(userId), profileId },
        },
        create: {
          id: crypto.randomUUID(),
          ownerUserId: Number(userId),
          profileId,
          executionLocation,
          lastUsedAt: new Date(),
        },
        update: { executionLocation, lastUsedAt: new Date(), status: "ready" },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.ensureProfile", error);
    }
  },

  async getProfile({ userId, profileId } = {}) {
    try {
      return await prisma.browser_profiles.findUnique({
        where: {
          ownerUserId_profileId: {
            ownerUserId: Number(userId),
            profileId,
          },
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.getProfile", error);
    }
  },

  async updateProfileRoute({
    userId,
    profileId,
    networkRoute,
    preferredDriver,
    egressGrantId = undefined,
    lastRouteHealth = undefined,
  } = {}) {
    const route = String(networkRoute || "");
    if (!["direct", "system", "athena_egress"].includes(route))
      throw new Error("browser_profile_network_route_invalid");
    const driver = String(preferredDriver || "embedded");
    if (!["embedded", "system_chrome"].includes(driver))
      throw new Error("browser_profile_driver_invalid");
    try {
      return await prisma.browser_profiles.update({
        where: {
          ownerUserId_profileId: {
            ownerUserId: Number(userId),
            profileId: String(profileId),
          },
        },
        data: {
          networkRoute: route,
          preferredDriver: driver,
          routePolicyVersion: "browser-egress-route-v1",
          ...(egressGrantId !== undefined
            ? { egressGrantId: egressGrantId || null }
            : {}),
          ...(lastRouteHealth !== undefined
            ? { lastRouteHealth: lastRouteHealth || null }
            : {}),
          lastUsedAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.updateProfileRoute", error);
    }
  },

  async claimProfileLease({
    userId,
    profileId,
    leaseOwner,
    leaseMs = 120_000,
  } = {}) {
    const owner = String(leaseOwner || "").slice(0, 160);
    if (!owner) throw new Error("browser_profile_lease_owner_required");
    const now = new Date();
    try {
      const result = await prisma.browser_profiles.updateMany({
        where: {
          ownerUserId: Number(userId),
          profileId,
          status: { not: "deleted" },
          OR: [
            { leaseOwner: owner },
            { leaseOwner: null },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          leaseOwner: owner,
          leaseExpiresAt: new Date(
            now.getTime() + Math.max(30_000, Number(leaseMs) || 120_000)
          ),
          lastUsedAt: now,
        },
      });
      return result.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserPlane.claimProfileLease", error);
    }
  },

  async releaseProfileLease({ userId, profileId, leaseOwner } = {}) {
    try {
      const result = await prisma.browser_profiles.updateMany({
        where: {
          ownerUserId: Number(userId),
          profileId,
          leaseOwner: String(leaseOwner || ""),
        },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
      return result.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserPlane.releaseProfileLease", error);
    }
  },

  async updateProfileCheckpoint({ userId, profileId, checkpoint } = {}) {
    try {
      return await prisma.browser_profiles.update({
        where: {
          ownerUserId_profileId: {
            ownerUserId: Number(userId),
            profileId,
          },
        },
        data: {
          status: "ready",
          archiveRef: checkpoint?.objectRef || null,
          archiveManifestJson: checkpoint?.manifest
            ? JSON.stringify(checkpoint.manifest)
            : null,
          archiveSha256: checkpoint?.ciphertextSha256 || null,
          archiveBytes: Number(checkpoint?.bytes) || null,
          checkpointedAt: checkpoint?.checkpointedAt
            ? new Date(checkpoint.checkpointedAt)
            : null,
          lastUsedAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.updateProfileCheckpoint", error);
    }
  },

  async markProfileDeleted({ userId, profileId } = {}) {
    try {
      const result = await prisma.browser_profiles.updateMany({
        where: { ownerUserId: Number(userId), profileId },
        data: {
          status: "deleted",
          archiveRef: null,
          archiveManifestJson: null,
          archiveSha256: null,
          archiveBytes: null,
          checkpointedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return result.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserPlane.markProfileDeleted", error);
    }
  },

  async createSession(options = {}) {
    try {
      return await prisma.browser_sessions.create({
        data: {
          id: options.id || crypto.randomUUID(),
          ownerUserId: Number(options.userId),
          profileId: options.profileId,
          workerSessionId: options.workerSessionId || null,
          driver: options.driver,
          executionLocation: options.executionLocation,
          status: options.status || "starting",
          currentTabId: options.currentTabId || null,
          nodeId: options.nodeId || null,
          leaseOwner: options.leaseOwner || null,
          leaseExpiresAt: options.leaseExpiresAt || null,
          lastHeartbeatAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.createSession", error);
    }
  },

  async activeSession({ userId, executionLocation = null } = {}) {
    try {
      return await prisma.browser_sessions.findFirst({
        where: {
          ownerUserId: Number(userId),
          status: { in: ["starting", "active", "waiting_for_browser_node"] },
          ...(executionLocation ? { executionLocation } : {}),
        },
        orderBy: { updatedAt: "desc" },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.activeSession", error);
    }
  },

  async getSession({ userId, sessionId } = {}) {
    try {
      return await prisma.browser_sessions.findFirst({
        where: { id: sessionId, ownerUserId: Number(userId) },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.getSession", error);
    }
  },

  async idleSessions({ before, limit = 50 } = {}) {
    try {
      return await prisma.browser_sessions.findMany({
        where: {
          executionLocation: "cloud",
          status: { in: ["starting", "active"] },
          lastHeartbeatAt: { lt: new Date(before) },
        },
        orderBy: { lastHeartbeatAt: "asc" },
        take: Math.min(100, Math.max(1, Number(limit) || 50)),
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.idleSessions", error);
    }
  },

  async updateSession({ userId, sessionId, patch = {} } = {}) {
    try {
      const result = await prisma.browser_sessions.updateMany({
        where: { id: sessionId, ownerUserId: Number(userId) },
        data: { ...patch, lastHeartbeatAt: new Date() },
      });
      if (result.count !== 1) return null;
      return this.getSession({ userId, sessionId });
    } catch (error) {
      throwModelDataAccessError("browserPlane.updateSession", error);
    }
  },

  async upsertTabs({
    userId,
    sessionId,
    workspaceId = null,
    tabs = [],
    currentTabId = null,
  } = {}) {
    try {
      await prisma.$transaction(
        tabs.map((tab, position) =>
          prisma.browser_tabs.upsert({
            where: { id: tab.tabId },
            create: {
              id: tab.tabId,
              ownerUserId: Number(userId),
              sessionId,
              workspaceId,
              urlWithoutQuery: compactUrl(tab.url),
              title: tab.title ? String(tab.title).slice(0, 512) : null,
              position,
              status: "active",
            },
            update: {
              urlWithoutQuery: compactUrl(tab.url),
              title: tab.title ? String(tab.title).slice(0, 512) : undefined,
              position,
              status: "active",
              closedAt: null,
            },
          })
        )
      );
      await this.updateSession({ userId, sessionId, patch: { currentTabId } });
      return tabs;
    } catch (error) {
      throwModelDataAccessError("browserPlane.upsertTabs", error);
    }
  },

  async startTask(options = {}) {
    const userId = Number(options.userId);
    const idempotencyKey = String(
      options.idempotencyKey || crypto.randomUUID()
    );
    const argumentHash = sha256(options.arguments || {});
    try {
      try {
        const task = await prisma.browser_tasks.create({
          data: {
            id: options.taskId || crypto.randomUUID(),
            ownerUserId: userId,
            sessionId: options.sessionId || null,
            tabId: options.tabId || null,
            actorType: options.actorType || "user",
            action: options.action,
            status: options.status || "running",
            idempotencyKey,
            argumentHash,
            approvalRequestId: options.approvalRequestId || null,
            reasonCode: options.reasonCode || null,
            startedAt: new Date(),
          },
        });
        return { ...task, wasCreated: true };
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const task = await prisma.browser_tasks.findUnique({
          where: {
            ownerUserId_idempotencyKey: { ownerUserId: userId, idempotencyKey },
          },
        });
        if (
          !task ||
          task.sessionId !== (options.sessionId || null) ||
          task.action !== options.action ||
          task.argumentHash !== argumentHash
        ) {
          const conflict = new Error("browser_task_idempotency_conflict");
          conflict.code = "browser_task_idempotency_conflict";
          conflict.httpStatus = 409;
          throw conflict;
        }
        return { ...task, wasCreated: false };
      }
    } catch (error) {
      if (error?.code === "browser_task_idempotency_conflict") throw error;
      throwModelDataAccessError("browserPlane.startTask", error);
    }
  },

  async claimApprovedTask({ userId, taskId, approvalRequestId = null } = {}) {
    try {
      const result = await prisma.browser_tasks.updateMany({
        where: {
          id: taskId,
          ownerUserId: Number(userId),
          status: "approval_required",
          ...(approvalRequestId ? { approvalRequestId } : {}),
        },
        data: { status: "running", startedAt: new Date(), reasonCode: null },
      });
      return result.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserPlane.claimApprovedTask", error);
    }
  },

  async finishTask({
    userId,
    taskId,
    status,
    resultSha256 = null,
    reasonCode = null,
    checkpoint = null,
  } = {}) {
    try {
      const result = await prisma.browser_tasks.updateMany({
        where: { id: taskId, ownerUserId: Number(userId) },
        data: {
          status,
          resultSha256,
          reasonCode,
          checkpointJson: checkpoint ? JSON.stringify(checkpoint) : null,
          completedAt: new Date(),
        },
      });
      return result.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserPlane.finishTask", error);
    }
  },

  async createArtifact({
    userId,
    taskId = null,
    sessionId = null,
    type,
    buffer,
    mimeType,
    displayName = null,
    expiresAt = null,
  } = {}) {
    try {
      const id = crypto.randomUUID();
      const object = await ContentObject.stageBuffer({
        ownerType: "browser-user",
        ownerId: String(Number(userId)),
        domain: "browser-artifact",
        buffer,
        mimeType,
      });
      await prisma.$transaction([
        prisma.browser_artifacts.create({
          data: {
            id,
            ownerUserId: Number(userId),
            taskId,
            sessionId,
            type: String(type || "capture").slice(0, 64),
            displayName: displayName ? String(displayName).slice(0, 240) : null,
            mimeType: String(mimeType || "application/octet-stream").slice(
              0,
              160
            ),
            objectRef: object.id,
            sha256: object.plaintextSha256,
            sizeBytes: object.plaintextSize,
            status: "ready",
            expiresAt,
          },
        }),
        prisma.content_objects.update({
          where: { id: object.id },
          data: {
            state: "ready",
            readyAt: new Date(),
            deleteAfter: null,
            refCount: { increment: 1 },
          },
        }),
      ]);
      return {
        artifactId: id,
        type: String(type || "capture").slice(0, 64),
        mimeType: object.mimeType,
        displayName: displayName ? String(displayName).slice(0, 240) : null,
        bytes: object.plaintextSize,
        sha256: object.plaintextSha256,
      };
    } catch (error) {
      throwModelDataAccessError("browserPlane.createArtifact", error);
    }
  },

  async createArtifactFromFile({
    userId,
    taskId = null,
    sessionId = null,
    type,
    filePath,
    mimeType = "application/octet-stream",
    displayName = null,
    expectedBytes = null,
    expectedSha256 = null,
    expiresAt = null,
  } = {}) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error("browser_artifact_file_invalid");
      if (expectedBytes !== null && stat.size !== Number(expectedBytes))
        throw new Error("browser_artifact_size_mismatch");
      const hash = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(filePath))
        hash.update(chunk);
      const plaintextSha256 = hash.digest("hex");
      if (expectedSha256 && plaintextSha256 !== expectedSha256)
        throw new Error("browser_artifact_hash_mismatch");
      const id = crypto.randomUUID();
      const normalizedMime = String(
        mimeType || "application/octet-stream"
      ).slice(0, 160);
      const normalizedName = displayName
        ? String(displayName).slice(0, 240)
        : null;
      const object = await ContentObject.stageFileParts({
        ownerType: "browser-user",
        ownerId: String(Number(userId)),
        domain: "browser-artifact",
        filePaths: [filePath],
        plaintextSize: stat.size,
        plaintextSha256,
        mimeType: normalizedMime,
      });
      await prisma.$transaction([
        prisma.browser_artifacts.create({
          data: {
            id,
            ownerUserId: Number(userId),
            taskId,
            sessionId,
            type: String(type || "download").slice(0, 64),
            displayName: normalizedName,
            mimeType: normalizedMime,
            objectRef: object.id,
            sha256: object.plaintextSha256,
            sizeBytes: object.plaintextSize,
            status: "ready",
            expiresAt,
          },
        }),
        prisma.content_objects.update({
          where: { id: object.id },
          data: {
            state: "ready",
            readyAt: new Date(),
            deleteAfter: null,
            refCount: { increment: 1 },
          },
        }),
      ]);
      return {
        artifactId: id,
        type: String(type || "download").slice(0, 64),
        mimeType: normalizedMime,
        displayName: normalizedName,
        bytes: object.plaintextSize,
        sha256: object.plaintextSha256,
      };
    } catch (error) {
      throwModelDataAccessError("browserPlane.createArtifactFromFile", error);
    }
  },

  async listWorkspaces({ userId, limit = 50 } = {}) {
    try {
      return (
        await prisma.browser_workspaces.findMany({
          where: { ownerUserId: Number(userId) },
          orderBy: { updatedAt: "desc" },
          take: Math.min(100, Math.max(1, Number(limit) || 50)),
        })
      ).map(publicWorkspace);
    } catch (error) {
      throwModelDataAccessError("browserPlane.listWorkspaces", error);
    }
  },

  async saveWorkspace({
    userId,
    workspaceId = null,
    name,
    preferredLocation = "desktop",
    state = {},
  } = {}) {
    try {
      const normalizedLocation = ["desktop", "cloud"].includes(
        preferredLocation
      )
        ? preferredLocation
        : "desktop";
      const stateJson = JSON.stringify(state || {});
      if (Buffer.byteLength(stateJson, "utf8") > 64 * 1024) {
        const error = new Error("browser_workspace_state_too_large");
        error.code = "browser_workspace_state_too_large";
        error.httpStatus = 413;
        throw error;
      }
      const data = {
        name: String(name || "浏览器工作区").slice(0, 120),
        preferredLocation: normalizedLocation,
        stateJson,
      };
      if (!workspaceId) {
        return publicWorkspace(
          await prisma.browser_workspaces.create({
            data: {
              id: crypto.randomUUID(),
              ownerUserId: Number(userId),
              ...data,
            },
          })
        );
      }
      const result = await prisma.browser_workspaces.updateMany({
        where: { id: String(workspaceId), ownerUserId: Number(userId) },
        data,
      });
      if (result.count !== 1) {
        const error = new Error("browser_workspace_not_found");
        error.code = "browser_workspace_not_found";
        error.httpStatus = 404;
        throw error;
      }
      return publicWorkspace(
        await prisma.browser_workspaces.findFirst({
          where: { id: String(workspaceId), ownerUserId: Number(userId) },
        })
      );
    } catch (error) {
      if (
        [
          "browser_workspace_state_too_large",
          "browser_workspace_not_found",
        ].includes(error?.code)
      )
        throw error;
      throwModelDataAccessError("browserPlane.saveWorkspace", error);
    }
  },

  async addHistory({ userId, url, title = null } = {}) {
    const normalized = safePageUrl(url);
    if (!normalized) return null;
    try {
      return await prisma.browser_history.create({
        data: {
          id: crypto.randomUUID(),
          ownerUserId: Number(userId),
          title: title ? String(title).slice(0, 512) : null,
          ...normalized,
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.addHistory", error);
    }
  },

  async listHistory({ userId, limit = 100 } = {}) {
    try {
      return await prisma.browser_history.findMany({
        where: { ownerUserId: Number(userId) },
        orderBy: { visitedAt: "desc" },
        take: Math.min(100, Math.max(1, Number(limit) || 100)),
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.listHistory", error);
    }
  },

  async addBookmark({ userId, url, title = null } = {}) {
    const normalized = safePageUrl(url);
    if (!normalized) return null;
    try {
      return await prisma.browser_bookmarks.create({
        data: {
          id: crypto.randomUUID(),
          ownerUserId: Number(userId),
          title: title ? String(title).slice(0, 512) : null,
          ...normalized,
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.addBookmark", error);
    }
  },

  async listBookmarks({ userId, limit = 100 } = {}) {
    try {
      return await prisma.browser_bookmarks.findMany({
        where: { ownerUserId: Number(userId) },
        orderBy: { updatedAt: "desc" },
        take: Math.min(100, Math.max(1, Number(limit) || 100)),
      });
    } catch (error) {
      throwModelDataAccessError("browserPlane.listBookmarks", error);
    }
  },
};

module.exports = { BrowserPlane };
