const { requestInternalService } = require("../microModules/internalClient");

function externalCenterEnabled(env = process.env) {
  return Boolean(String(env.ATHENA_LOCAL_RUNTIME_CENTER_URL || "").trim());
}

async function dispatchLocalRuntime(operation, input = {}, options = {}) {
  const env = options.env || process.env;
  if (!externalCenterEnabled(env)) {
    const { localRuntimeCenter } = require("./runtime");
    const handlers = {
      dispatch: (payload) => localRuntimeCenter.dispatch(payload),
      cancel: (payload) => localRuntimeCenter.cancel(payload),
      status: () => localRuntimeCenter.snapshot(),
      issuePairingTicket: (payload) =>
        localRuntimeCenter.issuePairingTicket(payload),
      listDevices: (payload) =>
        localRuntimeCenter.listDevices(payload.ownerUserId),
      revokeDevice: (payload) =>
        localRuntimeCenter.revokeDevice(payload.ownerUserId, payload.deviceId),
      createLease: (payload) => localRuntimeCenter.createLease(payload),
      listLeases: (payload) =>
        localRuntimeCenter.listLeases(
          payload.ownerUserId,
          payload.deviceId || null
        ),
      revokeLease: (payload) =>
        localRuntimeCenter.revokeLease(payload.ownerUserId, payload.leaseId),
      listJobs: (payload) =>
        localRuntimeCenter.listJobs(
          payload.ownerUserId,
          payload.deviceId || null
        ),
      jobEvents: (payload) =>
        localRuntimeCenter.jobEvents(
          payload.ownerUserId,
          payload.jobId,
          payload.afterSequence
        ),
    };
    const handler = handlers[operation];
    if (!handler) throw new Error("local_runtime_operation_unknown");
    return handler(input);
  }
  const baseUrl = String(env.ATHENA_LOCAL_RUNTIME_CENTER_URL).replace(
    /\/+$/,
    ""
  );
  const response = await requestInternalService({
    callerRole: String(env.ATHENA_RUNTIME_ROLE || "athena-api"),
    targetModule: "local-runtime-center",
    capability: "local-runtime.task",
    contractVersion: "1.0",
    url: `${baseUrl}/internal/v1/local-runtime/dispatch`,
    body: { operation, input },
    idempotencyKey: options.idempotencyKey || input.idempotencyKey || null,
    env,
    timeoutMs: Number(options.timeoutMs || 610_000),
  });
  return response.result;
}

module.exports = { dispatchLocalRuntime, externalCenterEnabled };
