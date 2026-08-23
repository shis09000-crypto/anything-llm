const { DataAccessCenter } = require("../utils/dataAccess");
const { DEFINITIONS } = require("../utils/externalMcp/registry");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { enabled } = require("./externalMcpOAuth");
const McpOAuth = DataAccessCenter.externalMcpOAuth;
const Workspace = DataAccessCenter.workspace;
const ToolInvocation = DataAccessCenter.toolInvocation;

const adminOnly = [validatedRequest, flexUserRoleValid([ROLES.admin])];

async function actor(request, response) {
  const user =
    response.locals.user || (await userFromSession(request, response));
  return {
    user,
    userId: Number(user?.id || 1),
    authUserId: user?.authUserId || null,
  };
}

function errorResponse(response, error) {
  return response.status(error.status || error.httpStatus || 400).json({
    success: false,
    error: error.code || "external_mcp_request_failed",
    message: String(error.message || "External MCP request failed.").slice(
      0,
      240
    ),
  });
}

function protectSecretResponse(response) {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
}

function requestedScopes(queryValue, maximumScopes) {
  const maximum = [...new Set((maximumScopes || []).map(String))];
  const requested = [
    ...new Set(
      String(queryValue || "")
        .split(/\s+/)
        .filter(Boolean)
    ),
  ];
  if (!requested.length) return maximum;
  if (requested.some((scope) => !maximum.includes(scope))) {
    const error = new Error("The requested OAuth scope is not permitted.");
    error.code = "invalid_scope";
    error.status = 400;
    throw error;
  }
  return requested;
}

async function availableWorkspaces(user) {
  return user ? Workspace.whereWithUser(user) : Workspace.where({});
}

function externalMcpManagementEndpoints(app) {
  app.get("/external-mcp/config", adminOnly, async (request, response) => {
    try {
      const owner = await actor(request, response);
      const [clients, grants, workspaces, calls] = await Promise.all([
        McpOAuth.listClients({ createdByUserId: owner.userId }),
        McpOAuth.listGrants({ ownerUserId: owner.userId }),
        availableWorkspaces(owner.user),
        ToolInvocation.recentExternalExecutions({
          ownerUserId: owner.userId,
          limit: 50,
        }),
      ]);
      return response.status(200).json({
        success: true,
        enabled: enabled(),
        endpoint: `${request.protocol}://${request.get("host")}/mcp`,
        authorizationServer: `${request.protocol}://${request.get("host")}`,
        protectedResourceMetadata: `${request.protocol}://${request.get("host")}/.well-known/oauth-protected-resource/mcp`,
        clients,
        grants,
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
        })),
        tools: DEFINITIONS.map((definition) => ({
          name: definition.name,
          description: definition.description,
          scope: definition.scope,
          workspaceRequired: definition.workspaceRequired,
          risk: "read-only",
        })),
        calls: calls.map((call) => ({
          id: call.id,
          toolName: call.toolName,
          status: call.status,
          reasonCode: call.reasonCode,
          startedAt: call.startedAt,
          completedAt: call.completedAt,
          createdAt: call.approvalRequestedAt,
        })),
      });
    } catch (error) {
      return errorResponse(response, error);
    }
  });

  app.get(
    "/external-mcp/authorize-preview",
    [validatedRequest],
    async (request, response) => {
      try {
        const owner = await actor(request, response);
        const client = await McpOAuth.getClient(request.query.client_id);
        if (
          !client ||
          client.status !== "active" ||
          client.clientType !== "interactive"
        )
          return response
            .status(404)
            .json({ success: false, error: "invalid_client" });
        const all = await availableWorkspaces(owner.user);
        const maximumScopes = JSON.parse(client.maxScopesJson || "[]");
        const scopes = requestedScopes(request.query.scope, maximumScopes);
        const scopeSet = new Set(scopes);
        const maxWorkspaceIds = new Set(
          JSON.parse(client.maxWorkspacesJson || "[]").map((value) =>
            Number(String(value).split(":", 1)[0])
          )
        );
        return response.json({
          success: true,
          client: { clientId: client.clientId, name: client.name },
          scopes,
          tools: DEFINITIONS.filter(
            (definition) =>
              JSON.parse(client.maxToolsJson || "[]").includes(
                definition.name
              ) && scopeSet.has(definition.scope)
          ).map((definition) => ({
            name: definition.name,
            description: definition.description,
            scope: definition.scope,
          })),
          workspaces: all
            .filter((workspace) => maxWorkspaceIds.has(Number(workspace.id)))
            .map((workspace) => ({
              id: workspace.id,
              slug: workspace.slug,
              name: workspace.name,
            })),
        });
      } catch (error) {
        return errorResponse(response, error);
      }
    }
  );

  app.post("/external-mcp/clients", adminOnly, async (request, response) => {
    try {
      if (!enabled())
        return response
          .status(503)
          .json({ success: false, error: "external_mcp_disabled" });
      const owner = await actor(request, response);
      const body = reqBody(request) || {};
      const knownTools = new Map(
        DEFINITIONS.map((definition) => [definition.name, definition])
      );
      const maxTools = [
        ...new Set((Array.isArray(body.tools) ? body.tools : []).map(String)),
      ].filter((name) => knownTools.has(name));
      const maxScopes = [
        ...new Set(maxTools.map((name) => knownTools.get(name).scope)),
      ];
      const allowed = new Map(
        (await availableWorkspaces(owner.user)).map((workspace) => [
          Number(workspace.id),
          workspace,
        ])
      );
      const maxWorkspaces = [
        ...new Set(
          (Array.isArray(body.workspaceIds) ? body.workspaceIds : []).map(
            Number
          )
        ),
      ]
        .filter((id) => allowed.has(id))
        .map((id) => `${id}:${allowed.get(id).slug}`);
      const result = await McpOAuth.createClient({
        name: body.name,
        clientType: body.clientType,
        redirectUris: body.redirectUris,
        maxScopes,
        maxTools,
        maxWorkspaces,
        createdByUserId: owner.userId,
        createdByAuthUserId: owner.authUserId,
      });
      if (result.client.clientType === "service") {
        await McpOAuth.createGrant({
          client: await McpOAuth.getClient(result.client.clientId),
          ownerUserId: owner.userId,
          ownerAuthUserId: owner.authUserId,
          scopes: maxScopes,
          tools: maxTools,
          workspaces: maxWorkspaces.map((value) => {
            const [id, ...slug] = value.split(":");
            return { id: Number(id), slug: slug.join(":") };
          }),
          expiresInDays: Math.min(
            Math.max(Number(body.expiresInDays) || 30, 1),
            90
          ),
        });
      }
      protectSecretResponse(response);
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      return errorResponse(response, error);
    }
  });

  app.post(
    "/external-mcp/clients/:clientId/rotate",
    adminOnly,
    async (request, response) => {
      try {
        const owner = await actor(request, response);
        const result = await McpOAuth.rotateClientSecret(
          request.params.clientId,
          owner.userId
        );
        protectSecretResponse(response);
        return response.json({ success: true, ...result });
      } catch (error) {
        return errorResponse(response, error);
      }
    }
  );

  app.patch(
    "/external-mcp/clients/:clientId",
    adminOnly,
    async (request, response) => {
      try {
        const owner = await actor(request, response);
        const client = await McpOAuth.setClientStatus(
          request.params.clientId,
          reqBody(request)?.status,
          owner.userId
        );
        return response.json({ success: true, client });
      } catch (error) {
        return errorResponse(response, error);
      }
    }
  );

  app.delete(
    "/external-mcp/grants/:grantId",
    adminOnly,
    async (request, response) => {
      try {
        const owner = await actor(request, response);
        await McpOAuth.revokeGrant(
          request.params.grantId,
          owner.userId,
          "administrator_revoked"
        );
        return response.json({ success: true });
      } catch (error) {
        return errorResponse(response, error);
      }
    }
  );

  app.post(
    "/external-mcp/emergency-revoke",
    adminOnly,
    async (request, response) => {
      try {
        const owner = await actor(request, response);
        const revoked = await McpOAuth.emergencyRevokeAll(owner.userId);
        return response.json({ success: true, revoked });
      } catch (error) {
        return errorResponse(response, error);
      }
    }
  );
}

module.exports = { externalMcpManagementEndpoints };
