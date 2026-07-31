const crypto = require("crypto");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { userFromSession } = require("../../utils/http");
const {
  dispatchBrowserPlane,
} = require("../../utils/browserPlane/planeClient");

function route(handler) {
  return async (request, response) => {
    try {
      const user = await userFromSession(request, response);
      if (!user?.id)
        return response
          .status(401)
          .json({ success: false, error: "authentication_required" });
      const result = await handler({ request, response, user });
      if (response.headersSent) return;
      response.json({ success: true, result });
    } catch (error) {
      response.status(Number(error?.httpStatus) || 500).json({
        success: false,
        error: String(error?.code || error?.message || "browser_plane_failed")
          .replace(/[^a-zA-Z0-9_.:-]/g, "_")
          .slice(0, 160),
      });
    }
  };
}

function idempotencyKey(request) {
  return String(
    request.header("Idempotency-Key") ||
      request.body?.idempotencyKey ||
      crypto.randomUUID()
  ).slice(0, 256);
}

function browserEndpoints(app) {
  const auth = [validatedRequest, flexUserRoleValid([ROLES.all])];

  app.get(
    "/browser/status",
    auth,
    route(({ user }) =>
      dispatchBrowserPlane("status", { userId: user.id }, { timeoutMs: 10_000 })
    )
  );
  app.get(
    "/browser/nodes",
    auth,
    route(({ user }) =>
      dispatchBrowserPlane(
        "listNodes",
        { userId: user.id },
        { timeoutMs: 10_000 }
      )
    )
  );
  app.post(
    "/browser/nodes/heartbeat",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("registerNode", {
        userId: user.id,
        nodeId: request.body?.nodeId,
        capabilities: request.body?.capabilities,
        version: request.body?.version,
      })
    )
  );
  app.post(
    "/browser/sessions",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane(
        "createSession",
        {
          userId: user.id,
          location: request.body?.location,
          requestedProfileId: request.body?.profileId,
          viewport: request.body?.viewport,
        },
        { idempotencyKey: idempotencyKey(request) }
      )
    )
  );
  app.get(
    "/browser/sessions/:sessionId",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("session", {
        userId: user.id,
        sessionId: request.params.sessionId,
      })
    )
  );
  app.post(
    "/browser/sessions/:sessionId/stream-ticket",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("streamTicket", {
        userId: user.id,
        sessionId: request.params.sessionId,
        tabId: request.body?.tabId,
      })
    )
  );
  app.post(
    "/browser/sessions/:sessionId/actions",
    auth,
    route(({ request, user }) => {
      const invocationKey = idempotencyKey(request);
      return dispatchBrowserPlane(
        "action",
        {
          userId: user.id,
          sessionId: request.params.sessionId,
          tabId: request.body?.tabId,
          action: request.body?.action,
          arguments: request.body?.arguments || {},
          actorType: "user",
          idempotencyKey: invocationKey,
        },
        { idempotencyKey: invocationKey }
      );
    })
  );
  app.post(
    "/browser/sessions/:sessionId/tabs",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("newTab", {
        userId: user.id,
        sessionId: request.params.sessionId,
        url: request.body?.url,
      })
    )
  );
  app.delete(
    "/browser/sessions/:sessionId/tabs/:tabId",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("closeTab", {
        userId: user.id,
        sessionId: request.params.sessionId,
        tabId: request.params.tabId,
      })
    )
  );
  app.get(
    "/browser/sessions/:sessionId/cookies",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("cookies", {
        userId: user.id,
        sessionId: request.params.sessionId,
      })
    )
  );
  app.delete(
    "/browser/sessions/:sessionId/cookies/:domain",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("clearCookies", {
        userId: user.id,
        sessionId: request.params.sessionId,
        domain: request.params.domain,
      })
    )
  );
  app.post(
    "/browser/sessions/:sessionId/close",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("closeSession", {
        userId: user.id,
        sessionId: request.params.sessionId,
      })
    )
  );
  app.delete(
    "/browser/profiles/:profileId",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("deleteProfile", {
        userId: user.id,
        requestedProfileId: request.params.profileId,
      })
    )
  );
  app.get(
    "/browser/workspaces",
    auth,
    route(({ user }) =>
      dispatchBrowserPlane("listWorkspaces", { userId: user.id })
    )
  );
  app.post(
    "/browser/workspaces",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("saveWorkspace", {
        userId: user.id,
        input: request.body || {},
      })
    )
  );
  app.get(
    "/browser/history",
    auth,
    route(({ user }) =>
      dispatchBrowserPlane("listHistory", { userId: user.id })
    )
  );
  app.get(
    "/browser/bookmarks",
    auth,
    route(({ user }) =>
      dispatchBrowserPlane("listBookmarks", { userId: user.id })
    )
  );
  app.post(
    "/browser/bookmarks",
    auth,
    route(({ request, user }) =>
      dispatchBrowserPlane("addBookmark", {
        userId: user.id,
        input: request.body || {},
      })
    )
  );
}

module.exports = { browserEndpoints };
