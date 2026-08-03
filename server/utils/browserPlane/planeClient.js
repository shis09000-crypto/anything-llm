const { requestInternalService } = require("../microModules/internalClient");

function distributed(env = process.env) {
  return ["distributed", "micro-modules"].includes(
    String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      .trim()
      .toLowerCase()
  );
}

function endpoint(env = process.env) {
  return String(
    env.ATHENA_BROWSER_PLANE_URL || "http://127.0.0.1:3030"
  ).replace(/\/+$/, "");
}

const OPERATION_CAPABILITIES = Object.freeze({
  status: "browser.node",
  registerNode: "browser.node",
  listNodes: "browser.node",
  listWorkspaces: "browser.workspace",
  saveWorkspace: "browser.workspace",
  listHistory: "browser.workspace",
  listBookmarks: "browser.workspace",
  addBookmark: "browser.workspace",
  egressStatus: "browser.node",
  profileRoute: "browser.node",
  setProfileRoute: "browser.node",
  enrollEgress: "browser.node",
  renewEgress: "browser.node",
  revokeEgress: "browser.node",
  openSystemChrome: "browser.node",
  confirmProfileRoute: "browser.node",
});

function capabilityForOperation(operation) {
  return OPERATION_CAPABILITIES[operation] || "browser.session";
}

function callerIdentity(env = process.env) {
  const runtimeRole = String(env.ATHENA_RUNTIME_ROLE || "tool-broker");
  if (["api", "athena-api"].includes(runtimeRole))
    return { transportRole: "api", moduleId: "athena-api" };
  return { transportRole: runtimeRole, moduleId: runtimeRole };
}

async function dispatchBrowserPlane(operation, input = {}, options = {}) {
  if (!distributed()) {
    const { browserPlaneRuntime } = require("./runtime");
    const handlers = {
      createSession: (payload) => browserPlaneRuntime.createSession(payload),
      session: (payload) => browserPlaneRuntime.session(payload),
      streamTicket: (payload) => browserPlaneRuntime.streamTicket(payload),
      action: (payload) => browserPlaneRuntime.action(payload),
      newTab: (payload) => browserPlaneRuntime.newTab(payload),
      closeTab: (payload) => browserPlaneRuntime.closeTab(payload),
      cookies: (payload) => browserPlaneRuntime.cookies(payload),
      clearCookies: (payload) => browserPlaneRuntime.clearCookies(payload),
      closeSession: (payload) => browserPlaneRuntime.closeSession(payload),
      deleteProfile: (payload) => browserPlaneRuntime.deleteProfile(payload),
      listWorkspaces: (payload) =>
        browserPlaneRuntime.listWorkspaces(payload.userId),
      saveWorkspace: (payload) =>
        browserPlaneRuntime.saveWorkspace(payload.userId, payload.input || {}),
      listHistory: (payload) => browserPlaneRuntime.listHistory(payload.userId),
      listBookmarks: (payload) =>
        browserPlaneRuntime.listBookmarks(payload.userId),
      addBookmark: (payload) =>
        browserPlaneRuntime.addBookmark(payload.userId, payload.input || {}),
      egressStatus: (payload) => browserPlaneRuntime.egressStatus(payload),
      profileRoute: (payload) => browserPlaneRuntime.profileRoute(payload),
      setProfileRoute: (payload) =>
        browserPlaneRuntime.setProfileRoute(payload),
      enrollEgress: (payload) => browserPlaneRuntime.enrollEgress(payload),
      renewEgress: (payload) => browserPlaneRuntime.renewEgress(payload),
      revokeEgress: (payload) => browserPlaneRuntime.revokeEgress(payload),
      openSystemChrome: (payload) =>
        browserPlaneRuntime.openSystemChrome(payload),
      confirmProfileRoute: (payload) =>
        browserPlaneRuntime.confirmProfileRoute(payload),
      registerNode: (payload) => browserPlaneRuntime.registerNode(payload),
      listNodes: (payload) => browserPlaneRuntime.nodesForUser(payload.userId),
      status: () => browserPlaneRuntime.snapshot(),
    };
    const handler = handlers[operation];
    if (!handler)
      throw Object.assign(new Error("browser_plane_operation_unknown"), {
        httpStatus: 400,
      });
    return handler(input);
  }
  const caller = callerIdentity(process.env);
  const response = await requestInternalService({
    callerRole: caller.transportRole,
    callerModule: caller.moduleId,
    url: `${endpoint()}/internal/v1/browser/dispatch`,
    targetModule: "browser-plane",
    capability: capabilityForOperation(operation),
    contractVersion: "1.0",
    body: { operation, input },
    idempotencyKey: options.idempotencyKey || input.idempotencyKey || null,
    env: process.env,
    timeoutMs: Number(options.timeoutMs || 40_000),
  });
  return response.result;
}

module.exports = {
  callerIdentity,
  capabilityForOperation,
  dispatchBrowserPlane,
  distributed,
  endpoint,
};
