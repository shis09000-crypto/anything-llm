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
  const response = await requestInternalService({
    callerRole:
      process.env.ATHENA_RUNTIME_ROLE === "api"
        ? "athena-api"
        : process.env.ATHENA_RUNTIME_ROLE || "tool-broker",
    url: `${endpoint()}/internal/v1/browser/dispatch`,
    body: { operation, input },
    idempotencyKey: options.idempotencyKey || input.idempotencyKey || null,
    env: process.env,
    timeoutMs: Number(options.timeoutMs || 40_000),
  });
  return response.result;
}

module.exports = {
  dispatchBrowserPlane,
  distributed,
  endpoint,
};
