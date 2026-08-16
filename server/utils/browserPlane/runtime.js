const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { metrics } = require("../observability/metrics");
const { ensureStoragePath } = require("../environment");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { dispatchBrowserEgress } = require("../browserEgress/client");
const { browserPermissionDecision, compactUrl, sha256 } = require(".");
const {
  workerAction,
  workerClearCookieSite,
  workerCloseSession,
  workerCloseTab,
  workerCookieSummary,
  workerCreateSession,
  workerDeleteProfile,
  workerDeleteDownload,
  workerDownloadToFile,
  workerInspectActionRisk,
  workerNewTab,
  workerSession,
  workerStreamTicket,
} = require("./workerClient");

const BrowserData = lazyDataAccessFacade("browserPlane");
const MAX_ACTION_ARGUMENT_BYTES = 64 * 1024;

function validatedActionArguments(value) {
  const args =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw Object.assign(new Error("browser_action_arguments_invalid"), {
      code: "browser_action_arguments_invalid",
      httpStatus: 400,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ACTION_ARGUMENT_BYTES)
    throw Object.assign(new Error("browser_action_arguments_too_large"), {
      code: "browser_action_arguments_too_large",
      httpStatus: 413,
    });
  return args;
}

function profileId(userId, requested = "default") {
  return `bp-${crypto
    .createHash("sha256")
    .update(`${Number(userId)}:${String(requested || "default")}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function userRef(userId) {
  return `u-${Number(userId)}`;
}

function publicNode(node) {
  if (!node) return null;
  return {
    nodeId: node.nodeId,
    userId: node.userId,
    capabilities: {
      ...node.capabilities,
      egressEncryptionPublicKey: undefined,
      egressKeyAvailable: Boolean(node.capabilities?.egressEncryptionPublicKey),
    },
    version: node.version,
    lastSeenAt: new Date(node.lastSeenAt).toISOString(),
  };
}

function profileNetwork(profile, effectiveRoute = null) {
  const requestedRoute = profile?.networkRoute || "system";
  return {
    requestedRoute,
    effectiveRoute: effectiveRoute || requestedRoute,
    region: requestedRoute === "athena_egress" ? "overseas" : "local",
    connected: requestedRoute !== "athena_egress",
    latencyMs: null,
    grantExpiresAt: null,
    degradedReason:
      requestedRoute === "athena_egress"
        ? "browser_egress_connection_not_confirmed"
        : null,
    routePolicyVersion:
      profile?.routePolicyVersion || "browser-egress-route-v1",
  };
}

function pageMetadata(result) {
  const observation = result?.observation || {};
  return {
    url: compactUrl(observation.url),
    title: String(observation.title || "").slice(0, 512),
  };
}

function browserEvent(
  eventType,
  { outcome = "observed", action = null, driver = null, reasonCode = null } = {}
) {
  emitSemanticEvent({
    eventType,
    category: "browser-plane",
    severity: outcome === "failed" ? "error" : "info",
    outcome,
    subject: {
      type: "browser",
      component: driver || "browser-plane",
      operation: action || "lifecycle",
    },
    stateTransition: reasonCode ? { reasonCode } : undefined,
    sensitivity: "metadata_only",
  });
}

class BrowserPlaneRuntime {
  constructor() {
    this.accepting = true;
    this.nodes = new Map();
    this.sessionStarts = new Map();
    this.stats = {
      sessionsCreated: 0,
      actionsCompleted: 0,
      approvalsRequired: 0,
      failures: 0,
    };
    this.idleTimeoutMs = Number(
      process.env.BROWSER_SESSION_IDLE_TIMEOUT_MS || 10 * 60_000
    );
    this.sweeper = null;
  }

  start() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), 30_000);
    this.sweeper.unref?.();
  }

  async sweepIdle() {
    const sessions = await BrowserData.idleSessions({
      before: new Date(Date.now() - this.idleTimeoutMs),
    });
    for (const session of sessions) {
      await this.closeSession({
        userId: session.ownerUserId,
        sessionId: session.id,
        reason: "idle",
      }).catch(() => null);
    }
  }

  snapshot() {
    const nodeDeadline = Date.now() - 45_000;
    const nodes = [...this.nodes.values()].filter(
      (node) => node.lastSeenAt >= nodeDeadline
    );
    return {
      ready: this.accepting,
      executionPolicy: "desktop-primary-cloud-assist",
      cloudCapacity: Number(process.env.BROWSER_WORKER_MAX_SESSIONS || 1),
      desktopNodesOnline: nodes.length,
      freeMemoryBytes: os.freemem(),
      ...this.stats,
    };
  }

  registerNode({ userId, nodeId, capabilities = {}, version = null } = {}) {
    const id = String(nodeId || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id))
      throw Object.assign(new Error("browser_node_id_invalid"), {
        httpStatus: 400,
      });
    const key = `${Number(userId)}:${id}`;
    const isNew = !this.nodes.has(key);
    const node = {
      nodeId: id,
      userId: Number(userId),
      capabilities: {
        driver: "electron-webcontentsview",
        nonDrmVideo: capabilities.nonDrmVideo !== false,
        downloads: capabilities.downloads !== false,
        uploads: capabilities.uploads !== false,
        platform: String(capabilities.platform || "unknown").slice(0, 32),
        systemChrome: capabilities.systemChrome === true,
        proxyModes: Array.isArray(capabilities.proxyModes)
          ? capabilities.proxyModes
              .map((value) => String(value))
              .filter((value) =>
                ["direct", "system", "athena_egress"].includes(value)
              )
          : ["direct", "system"],
        egressEnvelopeVersion: String(
          capabilities.egressEnvelopeVersion || ""
        ).slice(0, 64),
        egressEncryptionPublicKey: String(
          capabilities.egressEncryptionPublicKey || ""
        ).slice(0, 8192),
      },
      version: String(version || "unknown").slice(0, 64),
      lastSeenAt: Date.now(),
    };
    this.nodes.set(key, node);
    if (isNew)
      browserEvent("browser.node.connected", {
        outcome: "success",
        driver: "electron-webcontentsview",
      });
    return publicNode(node);
  }

  nodesForUser(userId) {
    const deadline = Date.now() - 45_000;
    return [...this.nodes.values()]
      .filter(
        (node) => node.userId === Number(userId) && node.lastSeenAt >= deadline
      )
      .map(publicNode);
  }

  nodeForUser(userId, nodeId = null) {
    const deadline = Date.now() - 45_000;
    return (
      [...this.nodes.values()].find(
        (node) =>
          node.userId === Number(userId) &&
          node.lastSeenAt >= deadline &&
          (!nodeId || node.nodeId === String(nodeId))
      ) || null
    );
  }

  async createSession({
    userId,
    location = "cloud",
    requestedProfileId = "default",
    viewport = null,
  } = {}) {
    const executionLocation = location === "desktop" ? "desktop" : "cloud";
    const startKey = `${Number(userId)}:${executionLocation}:${String(
      requestedProfileId || "default"
    )}`;
    const activeStart = this.sessionStarts.get(startKey);
    if (activeStart) return activeStart;
    const start = this._createSession({
      userId,
      location: executionLocation,
      requestedProfileId,
      viewport,
    }).finally(() => this.sessionStarts.delete(startKey));
    this.sessionStarts.set(startKey, start);
    return start;
  }

  async _createSession({
    userId,
    location = "cloud",
    requestedProfileId = "default",
    viewport = null,
  } = {}) {
    if (!this.accepting)
      throw Object.assign(new Error("browser_plane_draining"), {
        httpStatus: 503,
      });
    const executionLocation = location === "desktop" ? "desktop" : "cloud";
    const id = profileId(userId, requestedProfileId);
    const profile = await BrowserData.ensureProfile({
      userId,
      profileId: id,
      executionLocation,
    });
    if (executionLocation === "desktop") {
      const rawNode = this.nodeForUser(userId);
      const node = publicNode(rawNode);
      const existing = await BrowserData.activeSession({
        userId,
        executionLocation,
      });
      if (existing) {
        const row = await BrowserData.updateSession({
          userId,
          sessionId: existing.id,
          patch: {
            nodeId: node?.nodeId || null,
            status: node ? "active" : "waiting_for_browser_node",
            errorCode: null,
          },
        });
        return {
          id: row.id,
          executionLocation,
          driver: row.driver,
          status: row.status,
          node,
          profile: {
            profileId: profile.profileId,
            networkRoute: profile.networkRoute || "system",
            preferredDriver: profile.preferredDriver || "embedded",
          },
          network: profileNetwork(profile),
        };
      }
      const row = await BrowserData.createSession({
        userId,
        profileId: id,
        driver: "electron-webcontentsview",
        executionLocation,
        status: node ? "active" : "waiting_for_browser_node",
        nodeId: node?.nodeId || null,
      });
      this.stats.sessionsCreated += 1;
      metrics.browserSessions.inc({
        driver: "electron-webcontentsview",
        action: "create",
        outcome: node ? "success" : "waiting",
      });
      browserEvent("browser.session.created", {
        outcome: node ? "success" : "waiting",
        action: "create",
        driver: "electron-webcontentsview",
      });
      return {
        id: row.id,
        executionLocation,
        driver: row.driver,
        status: row.status,
        node,
        profile: {
          profileId: profile.profileId,
          networkRoute: profile.networkRoute || "system",
          preferredDriver: profile.preferredDriver || "embedded",
        },
        network: profileNetwork(profile),
      };
    }
    const existing = await BrowserData.activeSession({
      userId,
      executionLocation: "cloud",
    });
    if (existing?.workerSessionId) {
      try {
        const worker = await workerSession(
          existing.workerSessionId,
          userRef(userId)
        );
        if (
          existing.leaseOwner &&
          !(await BrowserData.claimProfileLease({
            userId,
            profileId: id,
            leaseOwner: existing.leaseOwner,
          }))
        )
          throw Object.assign(new Error("browser_profile_lease_lost"), {
            code: "browser_profile_lease_lost",
            httpStatus: 409,
          });
        await BrowserData.updateSession({
          userId,
          sessionId: existing.id,
          patch: {
            leaseExpiresAt: new Date(Date.now() + 120_000),
            status: "active",
            errorCode: null,
          },
        });
        return {
          id: existing.id,
          ...worker,
          profile: {
            profileId: profile.profileId,
            networkRoute: profile.networkRoute || "system",
            preferredDriver: profile.preferredDriver || "embedded",
          },
          network: profileNetwork(profile, "direct"),
        };
      } catch {
        await BrowserData.updateSession({
          userId,
          sessionId: existing.id,
          patch: {
            status: "interrupted",
            errorCode: "browser_worker_session_lost",
            closedAt: new Date(),
          },
        });
        if (existing.leaseOwner)
          await BrowserData.releaseProfileLease({
            userId,
            profileId: id,
            leaseOwner: existing.leaseOwner,
          }).catch(() => false);
      }
    }
    const leaseOwner = `browser-plane:${crypto.randomUUID()}`;
    if (
      !(await BrowserData.claimProfileLease({
        userId,
        profileId: id,
        leaseOwner,
      }))
    )
      throw Object.assign(new Error("browser_profile_already_mounted"), {
        code: "browser_profile_already_mounted",
        httpStatus: 409,
      });
    let worker;
    let row;
    try {
      worker = await workerCreateSession({
        userRef: userRef(userId),
        profileId: id,
        profileArchive:
          profile.archiveRef && profile.archiveManifestJson
            ? {
                objectRef: profile.archiveRef,
                manifest: profile.archiveManifestJson,
              }
            : null,
        viewport,
      });
      row = await BrowserData.createSession({
        userId,
        profileId: id,
        workerSessionId: worker.sessionId,
        driver: worker.driver,
        executionLocation: "cloud",
        status: "active",
        currentTabId: worker.currentTabId,
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      });
    } catch (error) {
      await BrowserData.releaseProfileLease({
        userId,
        profileId: id,
        leaseOwner,
      }).catch(() => false);
      throw error;
    }
    await BrowserData.upsertTabs({
      userId,
      sessionId: row.id,
      tabs: worker.tabs,
      currentTabId: worker.currentTabId,
    });
    this.stats.sessionsCreated += 1;
    metrics.browserSessions.inc({
      driver: "playwright-chromium",
      action: "create",
      outcome: "success",
    });
    browserEvent("browser.session.created", {
      outcome: "success",
      action: "create",
      driver: "playwright-chromium",
    });
    return {
      id: row.id,
      ...worker,
      profile: {
        profileId: profile.profileId,
        networkRoute: profile.networkRoute || "system",
        preferredDriver: profile.preferredDriver || "embedded",
      },
      network: profileNetwork(profile, "direct"),
    };
  }

  async session({ userId, sessionId } = {}) {
    const row = await BrowserData.getSession({ userId, sessionId });
    if (!row)
      throw Object.assign(new Error("browser_session_not_found"), {
        httpStatus: 404,
      });
    if (row.executionLocation === "desktop") return row;
    if (
      row.leaseOwner &&
      !(await BrowserData.claimProfileLease({
        userId,
        profileId: row.profileId,
        leaseOwner: row.leaseOwner,
      }))
    )
      throw Object.assign(new Error("browser_profile_lease_lost"), {
        code: "browser_profile_lease_lost",
        httpStatus: 409,
      });
    const worker = await workerSession(row.workerSessionId, userRef(userId));
    await BrowserData.updateSession({
      userId,
      sessionId,
      patch: {
        leaseExpiresAt: new Date(Date.now() + 120_000),
        status: "active",
        errorCode: null,
      },
    });
    return { id: row.id, ...worker };
  }

  async streamTicket({ userId, sessionId, tabId = null } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session || session.executionLocation !== "cloud")
      throw Object.assign(new Error("browser_cloud_session_not_found"), {
        httpStatus: 404,
      });
    const ticket = await workerStreamTicket({
      sessionId: session.workerSessionId,
      userRef: userRef(userId),
      tabId,
    });
    return {
      streamPath: "/browser-stream",
      protocol: `athena-browser-ticket.${ticket.ticket}`,
      expiresAt: ticket.expiresAt,
      tabId: ticket.tabId,
    };
  }

  async action({
    userId,
    sessionId,
    tabId = null,
    action,
    arguments: args = {},
    actorType = "user",
    mode = "sandbox",
    intent = null,
    authorizedDomains = [],
    deniedDomains = [],
    approvalRequestId = null,
    approvalGranted = false,
    idempotencyKey = null,
  } = {}) {
    args = validatedActionArguments(args);
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session)
      throw Object.assign(new Error("browser_session_not_found"), {
        httpStatus: 404,
      });
    if (session.executionLocation !== "cloud")
      throw Object.assign(
        new Error("browser_desktop_action_requires_device_node"),
        {
          code: "browser_desktop_action_requires_device_node",
          httpStatus: 409,
        }
      );
    if (
      session.leaseOwner &&
      !(await BrowserData.claimProfileLease({
        userId,
        profileId: session.profileId,
        leaseOwner: session.leaseOwner,
      }))
    )
      throw Object.assign(new Error("browser_profile_lease_lost"), {
        code: "browser_profile_lease_lost",
        httpStatus: 409,
      });
    let targetUrl = action === "navigate" ? args.url : args.url || null;
    if (actorType === "agent" && !targetUrl) {
      const workerState = await workerSession(
        session.workerSessionId,
        userRef(userId)
      );
      const current = workerState.tabs?.find(
        (tab) => tab.tabId === (tabId || workerState.currentTabId)
      );
      targetUrl = current?.url || null;
    }
    let effectiveIntent = intent;
    if (
      actorType === "agent" &&
      ["click", "input", "key", "submit"].includes(action)
    ) {
      const inspected = await workerInspectActionRisk({
        sessionId: session.workerSessionId,
        userRef: userRef(userId),
        tabId,
        action,
        args,
      });
      if (inspected?.detected) effectiveIntent = inspected.intent;
    }
    const permission =
      actorType === "agent"
        ? browserPermissionDecision({
            mode,
            action,
            intent: effectiveIntent,
            url: targetUrl,
            authorizedDomains,
            administratorDeniedDomains: deniedDomains,
          })
        : {
            allowed: true,
            approvalRequired: false,
            reasonCode: "browser_user_direct_action",
            risk: "user_direct",
          };
    const key = String(idempotencyKey || crypto.randomUUID());
    const task = await BrowserData.startTask({
      userId,
      sessionId,
      tabId,
      actorType,
      action,
      arguments: args,
      idempotencyKey: key,
      approvalRequestId,
      status:
        permission.approvalRequired && !approvalGranted
          ? "approval_required"
          : "running",
      reasonCode: permission.reasonCode,
    });
    if (!task.wasCreated) {
      if (task.status === "completed" && task.resultSha256) {
        return {
          status: "duplicate_completed",
          taskId: task.id,
          resultSha256: task.resultSha256,
        };
      }
      if (task.status === "approval_required" && approvalGranted) {
        const claimed = await BrowserData.claimApprovedTask({
          userId,
          taskId: task.id,
          approvalRequestId,
        });
        if (!claimed)
          return {
            status: "duplicate_in_progress",
            taskId: task.id,
          };
      } else {
        return {
          status: ["running", "starting"].includes(task.status)
            ? "duplicate_in_progress"
            : task.status === "approval_required"
              ? "approval_required"
              : "duplicate_terminal",
          taskId: task.id,
          reasonCode: task.reasonCode,
          resultSha256: task.resultSha256,
        };
      }
    }
    if (
      !permission.allowed &&
      !(permission.approvalRequired && approvalGranted)
    ) {
      if (permission.approvalRequired) {
        this.stats.approvalsRequired += 1;
        metrics.browserApprovals.inc({
          risk: permission.risk,
          outcome: "requested",
        });
        browserEvent("browser.action.approval_requested", {
          outcome: "requested",
          action,
          driver: session.driver,
          reasonCode: permission.reasonCode,
        });
      }
      if (!permission.approvalRequired)
        await BrowserData.finishTask({
          userId,
          taskId: task.id,
          status: "denied",
          reasonCode: permission.reasonCode,
        });
      return {
        schemaVersion: "athena.browser.result.v1",
        runId: crypto.randomUUID(),
        taskId: task.id,
        sessionId,
        tabId,
        status: permission.approvalRequired ? "approval_required" : "denied",
        action,
        approval: {
          required: permission.approvalRequired,
          reasonCode: permission.reasonCode,
          risk: permission.risk,
          intent: permission.risk === "critical" ? effectiveIntent : undefined,
        },
        resultSha256: sha256({ taskId: task.id, permission }),
      };
    }
    try {
      let result = await workerAction({
        sessionId: session.workerSessionId,
        userRef: userRef(userId),
        tabId,
        action,
        args,
        runId: task.id,
        idempotencyKey: key,
      });
      if (result?.observation?.frame?.data && args.persistArtifact) {
        const frame = result.observation.frame;
        const artifact = await BrowserData.createArtifact({
          userId,
          taskId: task.id,
          sessionId,
          type: "capture",
          buffer: Buffer.from(frame.data, "base64"),
          mimeType: frame.mimeType || "image/jpeg",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
        });
        result = {
          ...result,
          observation: {
            ...result.observation,
            frame: {
              artifactId: artifact.artifactId,
              mimeType: artifact.mimeType,
              bytes: artifact.bytes,
              capturedAt: frame.capturedAt,
            },
          },
          artifacts: [...(result.artifacts || []), artifact],
        };
      }
      const workerDownloads = (result?.artifacts || []).filter(
        (artifact) =>
          artifact?.source === "browser-worker-staged" && artifact.downloadId
      );
      if (workerDownloads.length) {
        const persisted = [];
        for (const download of workerDownloads) {
          const directory = ensureStoragePath(
            "browser-plane",
            "download-staging"
          );
          await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
          const temporaryPath = path.join(directory, crypto.randomUUID());
          try {
            const transferred = await workerDownloadToFile(
              {
                sessionId: session.workerSessionId,
                userRef: userRef(userId),
                downloadId: download.downloadId,
                expectedBytes: download.bytes,
              },
              temporaryPath,
              { maxBytes: 25 * 1024 * 1024 }
            );
            persisted.push(
              await BrowserData.createArtifactFromFile({
                userId,
                taskId: task.id,
                sessionId,
                type: "download",
                filePath: temporaryPath,
                mimeType: download.mimeType || "application/octet-stream",
                displayName: download.filename || null,
                expectedBytes: transferred.bytes,
                expectedSha256: transferred.sha256,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
              })
            );
            await workerDeleteDownload({
              sessionId: session.workerSessionId,
              userRef: userRef(userId),
              downloadId: download.downloadId,
            });
          } finally {
            await fs.promises.rm(temporaryPath, { force: true });
          }
        }
        result = {
          ...result,
          artifacts: [
            ...(result.artifacts || []).filter(
              (artifact) => artifact?.source !== "browser-worker-staged"
            ),
            ...persisted,
          ],
        };
      }
      if (result?.resultSha256) {
        const { resultSha256: _ignored, ...hashable } = result;
        result.resultSha256 = sha256(hashable);
      }
      const worker = await workerSession(
        session.workerSessionId,
        userRef(userId)
      );
      await BrowserData.upsertTabs({
        userId,
        sessionId,
        tabs: worker.tabs,
        currentTabId: worker.currentTabId,
      });
      await BrowserData.updateSession({
        userId,
        sessionId,
        patch: {
          currentTabId: worker.currentTabId,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          status: "active",
          errorCode: null,
        },
      });
      if (action === "navigate" && result?.observation?.url) {
        const meta = pageMetadata(result);
        await BrowserData.addHistory({
          userId,
          url: meta.url,
          title: meta.title,
        });
      }
      await BrowserData.finishTask({
        userId,
        taskId: task.id,
        status: "completed",
        resultSha256: result.resultSha256,
      });
      this.stats.actionsCompleted += 1;
      metrics.browserActions.inc({
        action,
        driver: session.driver,
        outcome: "success",
      });
      metrics.browserActionDuration.observe(
        { action, driver: session.driver, outcome: "success" },
        Math.max(0, Number(result.durationMs) || 0) / 1_000
      );
      browserEvent("browser.action.completed", {
        outcome: "success",
        action,
        driver: session.driver,
      });
      return { ...result, taskId: task.id };
    } catch (error) {
      this.stats.failures += 1;
      metrics.browserActions.inc({
        action,
        driver: session.driver,
        outcome: "failed",
      });
      browserEvent("browser.action.failed", {
        outcome: "failed",
        action,
        driver: session.driver,
        reasonCode: String(
          error.code || error.message || "browser_action_failed"
        ).slice(0, 160),
      });
      await BrowserData.finishTask({
        userId,
        taskId: task.id,
        status: "failed",
        reasonCode: String(
          error.code || error.message || "browser_action_failed"
        ).slice(0, 160),
      });
      throw error;
    }
  }

  async newTab({ userId, sessionId, url = "about:blank" } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session || session.executionLocation !== "cloud")
      throw Object.assign(new Error("browser_cloud_session_not_found"), {
        httpStatus: 404,
      });
    const worker = await workerNewTab({
      sessionId: session.workerSessionId,
      userRef: userRef(userId),
      url,
    });
    await BrowserData.upsertTabs({
      userId,
      sessionId,
      tabs: worker.tabs,
      currentTabId: worker.currentTabId,
    });
    return worker;
  }

  async closeTab({ userId, sessionId, tabId } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session || session.executionLocation !== "cloud")
      throw Object.assign(new Error("browser_cloud_session_not_found"), {
        httpStatus: 404,
      });
    const worker = await workerCloseTab({
      sessionId: session.workerSessionId,
      userRef: userRef(userId),
      tabId,
    });
    if (worker.status !== "closed")
      await BrowserData.upsertTabs({
        userId,
        sessionId,
        tabs: worker.tabs,
        currentTabId: worker.currentTabId,
      });
    return worker;
  }

  async cookies({ userId, sessionId } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session || session.executionLocation !== "cloud")
      throw Object.assign(new Error("browser_cloud_session_not_found"), {
        httpStatus: 404,
      });
    return workerCookieSummary({
      sessionId: session.workerSessionId,
      userRef: userRef(userId),
    });
  }

  async clearCookies({ userId, sessionId, domain } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session || session.executionLocation !== "cloud")
      throw Object.assign(new Error("browser_cloud_session_not_found"), {
        httpStatus: 404,
      });
    return workerClearCookieSite({
      sessionId: session.workerSessionId,
      userRef: userRef(userId),
      domain,
    });
  }

  async closeSession({ userId, sessionId, reason = "user" } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session)
      throw Object.assign(new Error("browser_session_not_found"), {
        httpStatus: 404,
      });
    let worker = null;
    let workerError = null;
    if (session.executionLocation === "cloud" && session.workerSessionId) {
      const previousProfile = await BrowserData.getProfile({
        userId,
        profileId: session.profileId,
      });
      try {
        worker = await workerCloseSession({
          sessionId: session.workerSessionId,
          userRef: userRef(userId),
          reason,
        });
        if (worker?.checkpoint?.checkpointed)
          await BrowserData.updateProfileCheckpoint({
            userId,
            profileId: session.profileId,
            checkpoint: worker.checkpoint,
          });
        if (
          worker?.checkpoint?.checkpointed &&
          previousProfile?.archiveRef &&
          previousProfile.archiveRef !== worker.checkpoint.objectRef
        )
          await workerDeleteProfile({
            profileId: session.profileId,
            objectRef: previousProfile.archiveRef,
          }).catch(() => false);
      } catch (error) {
        workerError = error;
      }
    }
    if (session.leaseOwner && !workerError)
      await BrowserData.releaseProfileLease({
        userId,
        profileId: session.profileId,
        leaseOwner: session.leaseOwner,
      }).catch(() => false);
    await BrowserData.updateSession({
      userId,
      sessionId,
      patch: {
        status: workerError ? "interrupted" : "closed",
        errorCode: workerError
          ? String(
              workerError.code ||
                workerError.message ||
                "browser_worker_close_failed"
            ).slice(0, 160)
          : null,
        closedAt: new Date(),
      },
    });
    metrics.browserSessions.inc({
      driver: session.driver,
      action: "close",
      outcome: workerError ? "failed" : "success",
    });
    browserEvent("browser.session.closed", {
      outcome: workerError ? "failed" : "success",
      action: "close",
      driver: session.driver,
      reasonCode: workerError
        ? String(workerError.code || workerError.message).slice(0, 160)
        : null,
    });
    return {
      id: sessionId,
      status: workerError ? "interrupted" : "closed",
      worker,
      ...(workerError
        ? {
            reasonCode: String(
              workerError.code ||
                workerError.message ||
                "browser_worker_close_failed"
            ).slice(0, 160),
          }
        : {}),
    };
  }

  async deleteProfile({ userId, requestedProfileId = "default" } = {}) {
    const id = profileId(userId, requestedProfileId);
    const profile = await BrowserData.getProfile({ userId, profileId: id });
    const result = await workerDeleteProfile({
      profileId: id,
      objectRef: profile?.archiveRef || null,
    });
    await BrowserData.markProfileDeleted({ userId, profileId: id });
    return result;
  }

  async egressStatus({ userId } = {}) {
    return dispatchBrowserEgress("status", { userId }, { timeoutMs: 10_000 });
  }

  async profileRoute({ userId, requestedProfileId = "default" } = {}) {
    const id = profileId(userId, requestedProfileId);
    const profile = await BrowserData.ensureProfile({
      userId,
      profileId: id,
      executionLocation: "desktop",
    });
    let network = profileNetwork(profile);
    if (profile.networkRoute === "athena_egress") {
      const node = this.nodeForUser(userId);
      network = node
        ? await dispatchBrowserEgress("resolve", {
            userId,
            profileId: id,
            deviceId: node.nodeId,
          })
        : {
            ...network,
            effectiveRoute: "unavailable",
            connected: false,
            degradedReason: "browser_node_offline",
          };
    }
    return {
      profileId: id,
      networkRoute: profile.networkRoute || "system",
      preferredDriver: profile.preferredDriver || "embedded",
      egressGrantId: profile.egressGrantId || null,
      routePolicyVersion:
        profile.routePolicyVersion || "browser-egress-route-v1",
      network,
    };
  }

  async setProfileRoute({
    userId,
    requestedProfileId = "default",
    networkRoute,
    preferredDriver = "embedded",
  } = {}) {
    if (!["direct", "system", "athena_egress"].includes(String(networkRoute)))
      throw Object.assign(new Error("browser_profile_network_route_invalid"), {
        code: "browser_profile_network_route_invalid",
        httpStatus: 400,
      });
    if (!["embedded", "system_chrome"].includes(String(preferredDriver)))
      throw Object.assign(new Error("browser_profile_driver_invalid"), {
        code: "browser_profile_driver_invalid",
        httpStatus: 400,
      });
    const id = profileId(userId, requestedProfileId);
    await BrowserData.ensureProfile({
      userId,
      profileId: id,
      executionLocation: "desktop",
    });
    if (networkRoute === "athena_egress") {
      const node = this.nodeForUser(userId);
      if (!node)
        throw Object.assign(new Error("browser_node_offline"), {
          code: "browser_node_offline",
          httpStatus: 409,
        });
      const resolved = await dispatchBrowserEgress("resolve", {
        userId,
        profileId: id,
        deviceId: node.nodeId,
      });
      if (!resolved.connected)
        throw Object.assign(
          new Error(resolved.degradedReason || "browser_egress_unavailable"),
          {
            code: resolved.degradedReason || "browser_egress_unavailable",
            httpStatus: 409,
          }
        );
    }
    await BrowserData.updateProfileRoute({
      userId,
      profileId: id,
      networkRoute,
      preferredDriver,
      lastRouteHealth: "route_selected_pending_device_confirmation",
    });
    return this.profileRoute({ userId, requestedProfileId });
  }

  async enrollEgress({ userId, requestedProfileId = "default", nodeId } = {}) {
    const id = profileId(userId, requestedProfileId);
    const node = this.nodeForUser(userId, nodeId);
    if (!node)
      throw Object.assign(new Error("browser_node_offline"), {
        code: "browser_node_offline",
        httpStatus: 409,
      });
    if (!node.capabilities.egressEncryptionPublicKey)
      throw Object.assign(new Error("browser_node_egress_key_unavailable"), {
        code: "browser_node_egress_key_unavailable",
        httpStatus: 409,
      });
    await BrowserData.ensureProfile({
      userId,
      profileId: id,
      executionLocation: "desktop",
    });
    const issued = await dispatchBrowserEgress(
      "issue",
      {
        userId,
        profileId: id,
        deviceId: node.nodeId,
        encryptionPublicKey: node.capabilities.egressEncryptionPublicKey,
      },
      { idempotencyKey: `browser-egress-enroll:${id}:${node.nodeId}` }
    );
    await BrowserData.updateProfileRoute({
      userId,
      profileId: id,
      networkRoute: "athena_egress",
      preferredDriver: "embedded",
      egressGrantId: issued.grant.id,
      lastRouteHealth: "grant_issued_pending_device_confirmation",
    });
    return {
      profileId: id,
      nodeId: node.nodeId,
      grant: issued.grant,
      sealedConfig: issued.sealedConfig,
      network: await dispatchBrowserEgress("resolve", {
        userId,
        profileId: id,
        deviceId: node.nodeId,
      }),
    };
  }

  async renewEgress({ userId, grantId } = {}) {
    return dispatchBrowserEgress(
      "renew",
      { userId, grantId },
      { idempotencyKey: `browser-egress-renew:${grantId}` }
    );
  }

  async revokeEgress({ userId, grantId } = {}) {
    const result = await dispatchBrowserEgress(
      "revoke",
      { userId, grantId },
      { idempotencyKey: `browser-egress-revoke:${grantId}` }
    );
    if (result.profileId) {
      await BrowserData.updateProfileRoute({
        userId,
        profileId: result.profileId,
        networkRoute: "system",
        preferredDriver: "embedded",
        egressGrantId: null,
        lastRouteHealth: "grant_revoked",
      }).catch(() => null);
    }
    return result;
  }

  async confirmProfileRoute({
    userId,
    requestedProfileId = "default",
    nodeId,
    networkRoute,
    connected,
    latencyMs = null,
    errorCode = null,
  } = {}) {
    const id = profileId(userId, requestedProfileId);
    const profile = await BrowserData.getProfile({ userId, profileId: id });
    if (!profile || profile.networkRoute !== networkRoute)
      throw Object.assign(
        new Error("browser_profile_route_confirmation_mismatch"),
        {
          code: "browser_profile_route_confirmation_mismatch",
          httpStatus: 409,
        }
      );
    const node = this.nodeForUser(userId, nodeId);
    if (!node)
      throw Object.assign(new Error("browser_node_offline"), {
        code: "browser_node_offline",
        httpStatus: 409,
      });
    await BrowserData.updateProfileRoute({
      userId,
      profileId: id,
      networkRoute,
      preferredDriver: profile.preferredDriver || "embedded",
      lastRouteHealth: connected
        ? `connected:${Math.max(0, Number(latencyMs) || 0)}`
        : `failed:${String(errorCode || "unknown").slice(0, 64)}`,
    });
    if (networkRoute === "athena_egress" && profile.egressGrantId)
      await dispatchBrowserEgress("recordHealth", {
        userId,
        grantId: profile.egressGrantId,
        code: connected ? "connected" : String(errorCode || "failed"),
        handshakeAt: connected ? new Date().toISOString() : null,
        latencyMs,
      });
    return this.profileRoute({ userId, requestedProfileId });
  }

  async openSystemChrome({ userId, sessionId, url = null } = {}) {
    const session = await BrowserData.getSession({ userId, sessionId });
    if (!session || session.executionLocation !== "desktop")
      throw Object.assign(new Error("browser_desktop_session_not_found"), {
        code: "browser_desktop_session_not_found",
        httpStatus: 404,
      });
    const node = this.nodeForUser(userId, session.nodeId);
    if (!node?.capabilities?.systemChrome)
      throw Object.assign(new Error("browser_system_chrome_unavailable"), {
        code: "browser_system_chrome_unavailable",
        httpStatus: 409,
      });
    const profile = await BrowserData.getProfile({
      userId,
      profileId: session.profileId,
    });
    return {
      action: "open_system_chrome",
      nodeId: node.nodeId,
      sessionId: session.id,
      profileId: session.profileId,
      networkRoute: profile?.networkRoute || "system",
      url: compactUrl(url) || "about:blank",
      requiresLocalConnector: true,
    };
  }

  async listWorkspaces(userId) {
    return BrowserData.listWorkspaces({ userId });
  }

  async saveWorkspace(userId, input) {
    return BrowserData.saveWorkspace({ userId, ...input });
  }

  async listHistory(userId) {
    return BrowserData.listHistory({ userId });
  }

  async listBookmarks(userId) {
    return BrowserData.listBookmarks({ userId });
  }

  async addBookmark(userId, input) {
    return BrowserData.addBookmark({ userId, ...input });
  }

  async drain() {
    this.accepting = false;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const sessions = await BrowserData.idleSessions({
      before: new Date(Date.now() + 365 * 24 * 60 * 60_000),
      limit: 100,
    }).catch(() => []);
    await Promise.allSettled(
      sessions.map((session) =>
        this.closeSession({
          userId: session.ownerUserId,
          sessionId: session.id,
          reason: "drain",
        })
      )
    );
  }
}

const browserPlaneRuntime = new BrowserPlaneRuntime();

module.exports = {
  BrowserPlaneRuntime,
  browserPlaneRuntime,
  profileId,
  userRef,
};
