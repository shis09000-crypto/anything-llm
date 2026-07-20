const SAFE_QUARANTINE_PATHS = new Set([
  "/ping",
  "/health",
  "/admin/security/keys/status",
  "/debug/communication/encryption",
]);

let state = {
  status: "uninitialized",
  quarantined: false,
  reason: null,
  runtimeRole: null,
  provider: null,
  activeKey: null,
  domains: [],
  writeBarrier: false,
  checkedAt: null,
};
let bootstrapPromise = null;

function sanitized(next = state) {
  return JSON.parse(JSON.stringify(next));
}

function securityState() {
  return sanitized();
}

function setSecurityState(updates = {}) {
  state = { ...state, ...updates, checkedAt: new Date().toISOString() };
  return securityState();
}

function setBootstrapPromise(promise) {
  bootstrapPromise = Promise.resolve(promise);
  return bootstrapPromise;
}

async function waitForSecurityBootstrap() {
  if (bootstrapPromise) await bootstrapPromise;
  return securityState();
}

function assertEncryptionWriteAllowed() {
  if (!state.quarantined && !state.writeBarrier) return true;
  const quarantined = state.quarantined;
  const error = new Error(
    quarantined ? "key_custody_quarantined" : "key_rotation_write_barrier"
  );
  error.code = quarantined
    ? "KEY_CUSTODY_QUARANTINED"
    : "KEY_ROTATION_WRITE_BARRIER";
  error.statusCode = 503;
  throw error;
}

function setRotationWriteBarrier(enabled, jobId = null) {
  return setSecurityState({
    writeBarrier: Boolean(enabled),
    rotationJobId: enabled ? jobId : null,
  });
}

function quarantineMiddleware(request, response, next) {
  return waitForSecurityBootstrap()
    .then((snapshot) => {
      if (!snapshot.quarantined || SAFE_QUARANTINE_PATHS.has(request.path)) {
        next();
        return;
      }
      response.status(503).json({
        success: false,
        error: "key_custody_quarantined",
        reason: snapshot.reason,
      });
    })
    .catch((error) => {
      response.status(503).json({
        success: false,
        error: "key_custody_bootstrap_failed",
        reason: error?.message || String(error),
      });
    });
}

function resetSecurityStateForTests() {
  state = {
    status: "uninitialized",
    quarantined: false,
    reason: null,
    runtimeRole: null,
    provider: null,
    activeKey: null,
    domains: [],
    writeBarrier: false,
    checkedAt: null,
  };
  bootstrapPromise = null;
}

module.exports = {
  assertEncryptionWriteAllowed,
  quarantineMiddleware,
  resetSecurityStateForTests,
  securityState,
  setBootstrapPromise,
  setRotationWriteBarrier,
  setSecurityState,
  waitForSecurityBootstrap,
};
