const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { reqBody } = require("../utils/http");
const { getClientContext } = require("../utils/clientIdentity");
const {
  createDeveloperSession,
  devControlEnabled,
  executeDeveloperCommand,
  logsSnapshot,
  queryLogs,
  registry,
  sessionSnapshot,
  verifyAgreementKey,
  verifyDeveloperCommandEnvelope,
} = require("../utils/devControl");
const {
  recordDeveloperCommandAudit,
} = require("../utils/devControl/commandAudit");
const { verifySignedRequest } = require("../utils/requestSigning");

function currentUserId(response) {
  return Number(response?.locals?.user?.id || 0) || null;
}

function disabledResponse(response) {
  return response.status(404).json({
    success: false,
    error: "developer_control_disabled",
  });
}

function requireDevControlEnabled(_request, response, next) {
  if (!devControlEnabled()) return disabledResponse(response);
  next();
}

async function requireSignedDevControlCommand(request, response, next) {
  if (!request.signedRequest?.ok) {
    const result = await verifySignedRequest(request);
    if (result.ok) {
      request.signedRequest = result;
      return next();
    }
    return response.status(401).json({
      success: false,
      error: "invalid_signed_request",
    });
  }
  next();
}

function devControlEndpoints(app) {
  if (!app) return;
  const middleware = [
    requireDevControlEnabled,
    validatedRequest,
    flexUserRoleValid([ROLES.admin]),
  ];

  app.post(
    "/dev-control/codex/session",
    middleware,
    async (request, response) => {
      const body = reqBody(request) || {};
      const userId = currentUserId(response);
      const context = getClientContext(request);
      if (!userId || !context?.clientId || context.legacy) {
        return response.status(401).json({
          success: false,
          error: "client_identity_required",
        });
      }
      if (!verifyAgreementKey(body.agreementKey)) {
        await recordDeveloperCommandAudit({
          event: "developer_control_session_rejected",
          level: "warn",
          message: "Developer session agreement key rejected.",
          userId,
          clientId: context.clientId,
          requestId: context.requestId || body.requestId || null,
          metadata: { reason: "agreement_key_invalid" },
        });
        return response.status(403).json({
          success: false,
          error: "developer_agreement_key_invalid",
        });
      }
      const { publicSession } = createDeveloperSession({
        userId,
        clientId: context.clientId,
        requestId: context.requestId || body.requestId || null,
      });
      await recordDeveloperCommandAudit({
        event: "developer_control_session_created",
        message: "Developer session created.",
        userId,
        clientId: context.clientId,
        sessionId: publicSession.sessionId,
        requestId: context.requestId || body.requestId || null,
      });
      return response.status(200).json({
        success: true,
        session: publicSession,
        commands: registry.list(),
      });
    }
  );

  app.post(
    "/dev-control/command",
    [...middleware, requireSignedDevControlCommand],
    async (request, response) => {
      const body = reqBody(request) || {};
      const userId = currentUserId(response);
      const context = getClientContext(request);
      const envelope = verifyDeveloperCommandEnvelope(body, {
        userId,
        clientId: context?.clientId,
      });
      if (!envelope.ok) {
        await recordDeveloperCommandAudit({
          event: "developer_control_command_rejected",
          level: "warn",
          message: "Developer command envelope rejected.",
          userId,
          clientId: context?.clientId || null,
          sessionId: body.sessionId || null,
          requestId: body.requestId || null,
          command: body.command || null,
          scope: body.scope || {},
          metadata: { code: envelope.code },
        });
        return response.status(401).json({
          success: false,
          code: envelope.code,
          message: "Developer command envelope is invalid.",
        });
      }

      const result = await executeDeveloperCommand({
        request,
        response,
        session: envelope.session,
        body,
        clientId: context.clientId,
        userId,
      });
      return response.status(result.success ? 200 : result.status || 500).json({
        ...result,
        auditId: result.commandId,
      });
    }
  );

  app.get("/dev-control/logs", middleware, async (request, response) => {
    return response.status(200).json({
      success: true,
      logs: queryLogs({
        source: request.query?.source || null,
        commandId: request.query?.commandId || null,
        limit: request.query?.limit || 100,
      }),
    });
  });

  app.get("/dev-control/snapshot", middleware, async (_request, response) => {
    return response.status(200).json({
      success: true,
      enabled: devControlEnabled(),
      commands: registry.list(),
      sessions: sessionSnapshot(),
      logs: logsSnapshot(),
    });
  });
}

module.exports = {
  devControlEndpoints,
};
