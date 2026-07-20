const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { issueRealtimeTicket } = require("../utils/authz/realtimePrincipal");

function realtimeAuthEndpoints(app) {
  if (!app) return;

  app.post(
    "/realtime/ticket",
    [validatedRequest],
    async (request, response) => {
      try {
        const body = reqBody(request) || {};
        const result = await issueRealtimeTicket({
          request,
          response,
          purpose: body.purpose,
          resourceId: body.resourceId || null,
        });
        response.setHeader("Cache-Control", "no-store");
        return response.status(201).json({ success: true, ...result });
      } catch (error) {
        return response.status(error.httpStatus || 401).json({
          success: false,
          error: error.code || "realtime_ticket_failed",
        });
      }
    }
  );
}

module.exports = { realtimeAuthEndpoints };
