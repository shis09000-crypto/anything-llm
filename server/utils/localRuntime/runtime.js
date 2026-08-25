const crypto = require("crypto");
const { EventEmitter } = require("events");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const {
  LOCAL_RUNTIME_PROTOCOL,
  TERMINAL_JOB_STATES,
  deviceSignaturePayload,
  pairingSignaturePayload,
  parseJson,
  publicDevice,
  publicJob,
  publicLease,
  sha256,
} = require("./contracts");
const { authorizeLocalRuntime } = require("./policy");
const {
  issueCapabilityAssertion,
  signingKeys,
} = require("./capabilityAssertion");

const LocalRuntimeData = lazyDataAccessFacade("localRuntime");
const MAX_CLOCK_SKEW_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

function runtimeError(code, httpStatus = 400) {
  return Object.assign(new Error(code), { code, httpStatus });
}

function safeSend(socket, value) {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(value));
  return true;
}

function sanitizeEventPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    message: String(source.message || "").slice(0, 1000),
    progress: Number.isFinite(Number(source.progress))
      ? Math.max(0, Math.min(100, Number(source.progress)))
      : undefined,
    state: source.state ? String(source.state).slice(0, 80) : undefined,
    screenshotAvailable: source.screenshotAvailable === true,
    outputBytes: Number(source.outputBytes || 0) || undefined,
  };
}

function emitJobSemanticEvent(job, status, reasonCode = null) {
  emitSemanticEvent({
    eventType: `local_runtime.job.${status}`,
    category: "local-runtime",
    severity: status === "failed" ? "error" : "info",
    outcome: status,
    subject: {
      type: "local-runtime-job",
      id: job.id,
      component: "local-runtime-center",
      operation: job.toolName,
    },
    actor: { type: "device-owner", id: job.ownerUserId },
    correlation: {
      invocationId: job.toolInvocationId,
    },
    metadata: {
      responseId: job.responseId,
      priority: job.priority,
      background: job.executionMode === "background",
      reasonCode,
    },
    sensitivity: "metadata_only",
  });
}

class LocalRuntimeCenter extends EventEmitter {
  constructor() {
    super();
    this.accepting = true;
    this.connections = new Map();
    this.pending = new Map();
    this.usedNonces = new Map();
    this.sweeper = null;
  }

  start() {
    signingKeys();
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepConnections(), 15_000);
    this.sweeper.unref?.();
  }

  snapshot() {
    const deadline = Date.now() - HEARTBEAT_TIMEOUT_MS;
    return {
      ready: this.accepting,
      protocol: LOCAL_RUNTIME_PROTOCOL,
      devicesOnline: [...this.connections.values()].filter(
        (connection) => connection.lastSeenAt >= deadline
      ).length,
      jobsAwaitingResult: this.pending.size,
    };
  }

  async drain() {
    this.accepting = false;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const connection of this.connections.values())
      connection.socket.close(1012, "server_restart");
    this.connections.clear();
  }

  sweepConnections() {
    const deadline = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const [deviceId, connection] of this.connections.entries()) {
      if (connection.lastSeenAt >= deadline) continue;
      connection.socket.close(4001, "heartbeat_timeout");
      this.connections.delete(deviceId);
      void LocalRuntimeData.heartbeatDevice({
        deviceId,
        connectionId: null,
        status: "offline",
      }).catch(() => null);
    }
    const nonceDeadline = Date.now() - MAX_CLOCK_SKEW_MS * 2;
    for (const [nonce, usedAt] of this.usedNonces.entries())
      if (usedAt < nonceDeadline) this.usedNonces.delete(nonce);
  }

  async issuePairingTicket(identity) {
    return LocalRuntimeData.issuePairingTicket(identity);
  }

  async listDevices(ownerUserId) {
    const devices = await LocalRuntimeData.listDevices({ ownerUserId });
    return devices.map((row) =>
      publicDevice(row, { online: this.connections.has(row.id) })
    );
  }

  async createLease(input) {
    const row = await LocalRuntimeData.createLease(input);
    return publicLease(row);
  }

  async listLeases(ownerUserId, deviceId = null) {
    return (await LocalRuntimeData.listLeases({ ownerUserId, deviceId })).map(
      publicLease
    );
  }

  async listJobs(ownerUserId, deviceId = null) {
    return (await LocalRuntimeData.listJobs({ ownerUserId, deviceId })).map(
      (row) => publicJob(row, { includeResult: false })
    );
  }

  async revokeDevice(ownerUserId, deviceId) {
    const jobs = await LocalRuntimeData.listJobs({ ownerUserId, deviceId });
    const connection = this.connections.get(deviceId);
    for (const job of jobs.filter(
      (row) => !TERMINAL_JOB_STATES.has(row.status)
    ))
      safeSend(connection?.socket, {
        type: "job.cancel",
        protocol: LOCAL_RUNTIME_PROTOCOL,
        jobId: job.id,
      });
    const revoked = await LocalRuntimeData.revokeDevice({
      ownerUserId,
      deviceId,
    });
    for (const job of jobs.filter(
      (row) => !TERMINAL_JOB_STATES.has(row.status)
    )) {
      this.releaseJobSlot(deviceId, job.id);
      this.settlePending(
        job.id,
        runtimeError("local_runtime_device_revoked", 409)
      );
    }
    connection?.socket?.close(4004, "device_revoked");
    this.connections.delete(deviceId);
    return { revoked };
  }

  async revokeLease(ownerUserId, leaseId) {
    const revoked = await LocalRuntimeData.revokeLease({
      ownerUserId,
      leaseId,
    });
    if (revoked) {
      const jobs = await LocalRuntimeData.listJobs({ ownerUserId });
      for (const job of jobs.filter(
        (row) => row.leaseId === leaseId && !TERMINAL_JOB_STATES.has(row.status)
      ))
        await this.cancel({ ownerUserId, jobId: job.id });
    }
    return { revoked };
  }

  async jobEvents(ownerUserId, jobId, afterSequence = 0) {
    const job = await LocalRuntimeData.job({ ownerUserId, jobId });
    if (!job) throw runtimeError("local_runtime_job_not_found", 404);
    return LocalRuntimeData.jobEvents({ jobId, afterSequence });
  }

  async handleDeviceSocket(socket) {
    let deviceId = null;
    const authenticationTimer = setTimeout(
      () => socket.close(4003, "authentication_timeout"),
      15_000
    );
    socket.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
        if (!deviceId) {
          const authenticated = await this.authenticateSocket(socket, message);
          deviceId = authenticated.deviceId;
          clearTimeout(authenticationTimer);
          return;
        }
        await this.handleDeviceMessage(deviceId, message);
      } catch (error) {
        safeSend(socket, {
          type: "error",
          code: String(
            error?.code || error?.message || "local_runtime_message_invalid"
          ),
        });
      }
    });
    socket.on("close", () => {
      clearTimeout(authenticationTimer);
      if (!deviceId) return;
      const current = this.connections.get(deviceId);
      if (current?.socket === socket) this.connections.delete(deviceId);
      void LocalRuntimeData.heartbeatDevice({
        deviceId,
        connectionId: null,
        status: "offline",
      }).catch(() => null);
      void LocalRuntimeData.markDeviceJobsWaiting({ deviceId }).catch(
        () => null
      );
    });
  }

  async authenticateSocket(socket, message) {
    if (message?.protocol !== LOCAL_RUNTIME_PROTOCOL)
      throw runtimeError("local_runtime_protocol_mismatch", 426);
    if (message.type === "pair") {
      if (String(message.device?.platform || "").toLowerCase() !== "macos")
        throw runtimeError("local_runtime_platform_unsupported", 400);
      if (String(message.device?.keyAlgorithm || "").toLowerCase() !== "p256")
        throw runtimeError("local_runtime_device_key_algorithm_invalid", 400);
      const timestamp = Number(message.timestamp);
      const nonce = String(message.nonce || "");
      if (
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS
      )
        throw runtimeError("local_runtime_device_clock_invalid", 401);
      if (!nonce || this.usedNonces.has(nonce))
        throw runtimeError("local_runtime_device_nonce_replayed", 401);
      let key;
      try {
        key = crypto.createPublicKey(
          String(message.device?.publicKeyPem || "")
        );
        if (key.asymmetricKeyType !== "ec")
          throw new Error("unexpected_key_type");
        if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
          throw new Error("unexpected_curve");
      } catch {
        throw runtimeError("local_runtime_device_public_key_invalid", 400);
      }
      const verified = crypto.verify(
        "sha256",
        Buffer.from(
          pairingSignaturePayload({
            pairingToken: message.pairingToken,
            publicKeyPem: message.device?.publicKeyPem,
            timestamp,
            nonce,
            connectionId: message.connectionId,
          })
        ),
        key,
        Buffer.from(String(message.signature || ""), "base64url")
      );
      if (!verified)
        throw runtimeError("local_runtime_device_signature_invalid", 401);
      this.usedNonces.set(nonce, Date.now());
      const device = await LocalRuntimeData.pairDevice({
        token: message.pairingToken,
        name: message.device?.name,
        platform: message.device?.platform,
        version: message.device?.version,
        publicKeyPem: message.device?.publicKeyPem,
        keyAlgorithm: message.device?.keyAlgorithm,
        capabilities: message.device?.capabilities,
        permissions: message.device?.permissions,
      });
      await this.activateConnection(socket, device, message.connectionId);
      safeSend(socket, {
        type: "paired",
        protocol: LOCAL_RUNTIME_PROTOCOL,
        deviceId: device.id,
        serverSigningPublicKey: signingKeys().publicKey,
      });
      return { deviceId: device.id };
    }
    if (message.type !== "hello")
      throw runtimeError("local_runtime_device_hello_required", 401);
    const timestamp = Number(message.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS
    )
      throw runtimeError("local_runtime_device_clock_invalid", 401);
    const nonce = String(message.nonce || "");
    if (!nonce || this.usedNonces.has(nonce))
      throw runtimeError("local_runtime_device_nonce_replayed", 401);
    const device = await LocalRuntimeData.device({
      deviceId: message.deviceId,
    });
    if (!device || device.revokedAt)
      throw runtimeError("local_runtime_device_revoked", 401);
    const verified = crypto.verify(
      "sha256",
      Buffer.from(deviceSignaturePayload(message)),
      device.publicKeyPem,
      Buffer.from(String(message.signature || ""), "base64url")
    );
    if (!verified)
      throw runtimeError("local_runtime_device_signature_invalid", 401);
    this.usedNonces.set(nonce, Date.now());
    await this.activateConnection(socket, device, message.connectionId);
    safeSend(socket, {
      type: "ready",
      protocol: LOCAL_RUNTIME_PROTOCOL,
      deviceId: device.id,
      serverSigningPublicKey: signingKeys().publicKey,
    });
    return { deviceId: device.id };
  }

  async activateConnection(socket, device, connectionId = crypto.randomUUID()) {
    const previous = this.connections.get(device.id);
    if (previous && previous.socket !== socket)
      previous.socket.close(4002, "connection_replaced");
    this.connections.set(device.id, {
      socket,
      connectionId: String(connectionId || crypto.randomUUID()).slice(0, 128),
      lastSeenAt: Date.now(),
      activeDesktopJobId: null,
      activeParallelJobs: new Set(),
    });
    await LocalRuntimeData.heartbeatDevice({
      deviceId: device.id,
      connectionId,
      version: device.version,
      status: "online",
    });
    emitSemanticEvent({
      eventType: "local_runtime.device.connected",
      category: "local-runtime",
      severity: "info",
      outcome: "success",
      subject: {
        type: "device",
        component: "local-runtime-center",
        operation: "connect",
      },
      sensitivity: "metadata_only",
    });
    await this.resumePending(device.id);
  }

  async resumePending(deviceId) {
    const jobs = await LocalRuntimeData.pendingJobs({ deviceId });
    for (const job of jobs) await this.sendJob(job).catch(() => null);
  }

  async dispatch({
    ownerUserId,
    ownerAuthUserId,
    deviceId,
    toolName,
    args = {},
    responseId = null,
    toolInvocationId = null,
    priority = "P2",
    idempotencyKey,
    executionMode = "interactive",
    stepUpApproved = false,
  } = {}) {
    const leaseRow = await LocalRuntimeData.activeLease({
      ownerUserId,
      deviceId,
    });
    const lease = leaseRow
      ? { ...publicLease(leaseRow), ownerAuthUserId: leaseRow.ownerAuthUserId }
      : null;
    if (!lease || lease.ownerAuthUserId !== String(ownerAuthUserId))
      throw runtimeError("local_runtime_lease_owner_mismatch", 403);
    const decision = authorizeLocalRuntime({
      toolName,
      args,
      lease,
      stepUpApproved,
    });
    if (!decision.allowed) {
      const error = runtimeError(
        decision.reasonCode,
        decision.approvalRequired ? 428 : 403
      );
      error.approvalRequired = decision.approvalRequired;
      error.risk = decision.risk;
      throw error;
    }
    if (toolName === "local_device_status") {
      const device = await LocalRuntimeData.device({ ownerUserId, deviceId });
      if (!device) throw runtimeError("local_runtime_device_not_found", 404);
      return {
        device: publicDevice(device, {
          online: this.connections.has(deviceId),
        }),
        lease,
      };
    }
    const deadlineAt = Math.min(
      Date.now() +
        (executionMode === "background" ? 24 * 60 * 60_000 : 10 * 60_000),
      new Date(lease.expiresAt).getTime()
    );
    const { row, wasCreated } = await LocalRuntimeData.createJob({
      ownerUserId,
      ownerAuthUserId,
      deviceId,
      leaseId: lease.id,
      responseId,
      toolInvocationId,
      toolName,
      riskLevel: decision.risk,
      stepUpApproved,
      priority,
      executionMode,
      idempotencyKey,
      payload: args,
      deadlineAt,
    });
    if (wasCreated) emitJobSemanticEvent(row, "created");
    if (!wasCreated && TERMINAL_JOB_STATES.has(row.status))
      return publicJob(row, { includeResult: true });
    const completion =
      executionMode === "background"
        ? null
        : this.waitForJob(row.id, Math.max(1_000, deadlineAt - Date.now()));
    if (!this.connections.has(deviceId)) {
      await LocalRuntimeData.transitionJob({
        jobId: row.id,
        status: "waiting_for_device",
      });
      if (executionMode === "background") return publicJob(row);
      return completion;
    }
    try {
      await this.sendJob(row);
    } catch (error) {
      if (completion) this.settlePending(row.id, error);
      throw error;
    }
    if (executionMode === "background") return publicJob(row);
    return completion;
  }

  async sendJob(job) {
    const connection = this.connections.get(job.deviceId);
    if (!connection) throw runtimeError("local_runtime_device_offline", 409);
    const desktopTask = String(job.toolName || "").startsWith("local_desktop_");
    if (
      desktopTask &&
      connection.activeDesktopJobId &&
      connection.activeDesktopJobId !== job.id
    )
      throw runtimeError("local_runtime_desktop_busy", 409);
    if (
      !desktopTask &&
      connection.activeParallelJobs.size >= 2 &&
      !connection.activeParallelJobs.has(job.id)
    )
      throw runtimeError("local_runtime_parallel_limit", 409);
    const payload = parseJson(job.payloadJson, {});
    const leaseRow = await LocalRuntimeData.activeLease({
      ownerUserId: job.ownerUserId,
      deviceId: job.deviceId,
    });
    if (!leaseRow || leaseRow.id !== job.leaseId)
      throw runtimeError("local_runtime_lease_inactive", 403);
    const lease = publicLease(leaseRow);
    const assertion = issueCapabilityAssertion({
      authUserId: job.ownerAuthUserId,
      deviceId: job.deviceId,
      leaseId: job.leaseId,
      jobId: job.id,
      tool: job.toolName,
      argumentHash: job.argumentHash,
      allowedRoots: lease.allowedRoots,
      allowedApps: lease.allowedApps,
      capabilities: lease.capabilities,
      deadline: new Date(
        Math.min(job.deadlineAt.getTime(), new Date(lease.expiresAt).getTime())
      ).toISOString(),
      idempotencyKey: job.idempotencyKey,
      riskLevel: job.riskLevel,
      stepUpApproved: job.stepUpApproved === true,
    });
    const assignedSlot = desktopTask ? "desktop" : "parallel";
    if (desktopTask) connection.activeDesktopJobId = job.id;
    else connection.activeParallelJobs.add(job.id);
    try {
      if (
        !safeSend(connection.socket, {
          type: "job.start",
          protocol: LOCAL_RUNTIME_PROTOCOL,
          deviceId: job.deviceId,
          jobId: job.id,
          attempt: job.attempt,
          sequence: job.lastSequence,
          deadline: job.deadlineAt.toISOString(),
          capability: job.toolName,
          argumentHash: job.argumentHash,
          args: payload,
          assertion,
        })
      )
        throw runtimeError("local_runtime_device_offline", 409);
      await LocalRuntimeData.transitionJob({
        jobId: job.id,
        status: "running",
      });
      await LocalRuntimeData.appendEvent({
        jobId: job.id,
        type: "athena.tool.started",
        payload: { message: "Local task started" },
      });
    } catch (error) {
      if (assignedSlot === "desktop") connection.activeDesktopJobId = null;
      else connection.activeParallelJobs.delete(job.id);
      throw error;
    }
  }

  waitForJob(jobId, timeoutMs) {
    const existing = this.pending.get(jobId);
    if (existing) return existing.promise;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(
      () => {
        this.pending.delete(jobId);
        rejectPromise(runtimeError("local_runtime_job_timeout", 504));
      },
      Math.min(timeoutMs, 10 * 60_000)
    );
    timer.unref?.();
    this.pending.set(jobId, {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    });
    return promise;
  }

  settlePending(jobId, error, value) {
    const pending = this.pending.get(jobId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(jobId);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  releaseJobSlot(deviceId, jobId) {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    if (connection.activeDesktopJobId === jobId)
      connection.activeDesktopJobId = null;
    connection.activeParallelJobs.delete(jobId);
  }

  async handleDeviceMessage(deviceId, message) {
    const connection = this.connections.get(deviceId);
    if (!connection)
      throw runtimeError("local_runtime_device_connection_missing", 401);
    connection.lastSeenAt = Date.now();
    if (message.type === "heartbeat") {
      await LocalRuntimeData.heartbeatDevice({
        deviceId,
        connectionId: connection.connectionId,
        version: message.version,
        capabilities: message.capabilities,
        permissions: message.permissions,
        status: message.paused ? "paused" : "online",
      });
      return;
    }
    const job = await LocalRuntimeData.job({ jobId: message.jobId });
    if (!job || job.deviceId !== deviceId)
      throw runtimeError("local_runtime_job_not_found", 404);
    if (message.type === "job.event") {
      const event = await LocalRuntimeData.appendEvent({
        jobId: job.id,
        type: String(message.eventType || "athena.tool.progress"),
        payload: sanitizeEventPayload(message.payload),
      });
      this.emit("job.event", { jobId: job.id, event });
      return;
    }
    const terminalStatus = {
      "job.completed": "completed",
      "job.failed": "failed",
      "job.cancelled": "cancelled",
      "job.denied": "denied",
    }[message.type];
    if (!terminalStatus)
      throw runtimeError("local_runtime_device_message_unknown", 400);
    const frameData = String(message.frame?.data || "");
    let invalidResult = null;
    if (frameData.length > 28 * 1024 * 1024)
      invalidResult = runtimeError("local_runtime_frame_too_large", 413);
    else if (
      message.result &&
      sha256(message.result) !== String(message.resultHash || "")
    )
      invalidResult = runtimeError("local_runtime_result_hash_invalid", 400);
    if (invalidResult) {
      await LocalRuntimeData.transitionJob({
        jobId: job.id,
        status: "failed",
        reasonCode: invalidResult.code,
      });
      await LocalRuntimeData.appendEvent({
        jobId: job.id,
        type: "athena.tool.failed",
        payload: { message: "Local task returned an invalid result" },
      });
      this.releaseJobSlot(job.deviceId, job.id);
      void this.resumePending(job.deviceId);
      this.settlePending(job.id, invalidResult);
      emitJobSemanticEvent(job, "failed", invalidResult.code);
      throw invalidResult;
    }
    const updated = await LocalRuntimeData.transitionJob({
      jobId: job.id,
      status: terminalStatus,
      reasonCode: message.reasonCode || null,
      result: message.result,
    });
    await LocalRuntimeData.appendEvent({
      jobId: job.id,
      type:
        terminalStatus === "completed"
          ? "athena.tool.completed"
          : "athena.tool.failed",
      payload: {
        message:
          terminalStatus === "completed"
            ? "Local task completed"
            : "Local task stopped",
      },
    });
    const ephemeralFrame = frameData
      ? {
          mimeType: String(message.frame.mimeType || "image/jpeg").slice(0, 80),
          data: frameData,
          capturedAt: message.frame.capturedAt || new Date().toISOString(),
        }
      : null;
    const publicResult = {
      ...publicJob(updated, { includeResult: true }),
      ...(ephemeralFrame ? { ephemeralFrame } : {}),
    };
    this.releaseJobSlot(job.deviceId, job.id);
    void this.resumePending(job.deviceId);
    emitJobSemanticEvent(updated, terminalStatus, message.reasonCode || null);
    if (terminalStatus === "completed")
      this.settlePending(job.id, null, publicResult);
    else
      this.settlePending(
        job.id,
        runtimeError(
          message.reasonCode || `local_runtime_job_${terminalStatus}`,
          409
        )
      );
  }

  async cancel({ ownerUserId, jobId }) {
    const job = await LocalRuntimeData.job({ ownerUserId, jobId });
    if (!job) throw runtimeError("local_runtime_job_not_found", 404);
    if (TERMINAL_JOB_STATES.has(job.status)) return publicJob(job);
    const connection = this.connections.get(job.deviceId);
    safeSend(connection?.socket, {
      type: "job.cancel",
      protocol: LOCAL_RUNTIME_PROTOCOL,
      jobId: job.id,
    });
    const updated = await LocalRuntimeData.transitionJob({
      jobId: job.id,
      status: "cancelled",
      reasonCode: "cancelled_by_owner",
    });
    this.releaseJobSlot(job.deviceId, job.id);
    void this.resumePending(job.deviceId);
    emitJobSemanticEvent(updated, "cancelled", "cancelled_by_owner");
    this.settlePending(
      job.id,
      runtimeError("local_runtime_job_cancelled", 409)
    );
    return publicJob(updated);
  }
}

const localRuntimeCenter = new LocalRuntimeCenter();

module.exports = { LocalRuntimeCenter, localRuntimeCenter };
