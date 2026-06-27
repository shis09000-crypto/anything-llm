const { userFromSession } = require("../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const {
  subscribeToSyncEvents,
  syncEventVisibleToUser,
} = require("../utils/syncCenter");

function syncCenterEndpoints(app) {
  if (!app) return;

  app.get(
    "/sync/events",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      const user = await userFromSession(request, response);
      const userId = user?.id ?? null;

      setSseTransportHeaders(response, {
        "Access-Control-Allow-Origin": "*",
      });
      response.flushHeaders?.();

      writeResponseChunk(response, {
        type: "sync_center_ready",
      });

      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, { type: "heartbeat" });
      }, 25_000);

      const unsubscribe = subscribeToSyncEvents((event) => {
        if (!syncEventVisibleToUser(event, userId)) return;
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, event);
      });

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.once("close", cleanup);
      response.once("close", cleanup);
    }
  );
}

module.exports = { syncCenterEndpoints };
