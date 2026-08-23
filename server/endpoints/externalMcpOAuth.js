const { DataAccessCenter } = require("../utils/dataAccess");
const { userFromSession, reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { emitSemanticEvent } = require("../utils/observability/semanticEvents");
const McpOAuth = DataAccessCenter.externalMcpOAuth;
const Workspace = DataAccessCenter.workspace;
const { DEFINITIONS } = require("../utils/externalMcp/registry");

function enabled(env = process.env) {
  return (
    String(env.ATHENA_EXTERNAL_MCP_ENABLED || "false").toLowerCase() === "true"
  );
}

function noStore(response) {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
}

function oauthFailure(response, error) {
  noStore(response);
  return response.status(error.status || error.httpStatus || 400).json({
    error: error.code || "server_error",
    error_description: String(error.message || "OAuth request failed.").slice(
      0,
      240
    ),
  });
}

function audit(
  eventType,
  {
    outcome,
    clientId = null,
    grantId = null,
    userId = null,
    errorCode = null,
  } = {}
) {
  try {
    emitSemanticEvent({
      eventType,
      category: "external_mcp",
      severity: outcome === "failed" ? "warning" : "info",
      outcome: outcome || "observed",
      subject: {
        type: "mcp-client",
        id: clientId || "unknown",
        operation: eventType,
      },
      actor: userId
        ? { type: "user", id: userId }
        : { type: "service", id: clientId || "unknown" },
      correlation: { clientId },
      metadata: { reasonCode: errorCode, runId: grantId },
      sensitivity: "metadata_only",
    });
  } catch {}
}

function bearer(request) {
  const header = String(request.get("authorization") || "");
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function registerExternalMcpOAuthRoutes(
  app,
  { includePublic = true, includeInternal = false } = {}
) {
  if (includePublic) {
    app.get("/oauth/mcp/authorize", async (request, response) => {
      if (!enabled())
        return oauthFailure(
          response,
          Object.assign(new Error("External MCP is disabled."), {
            code: "temporarily_unavailable",
            status: 503,
          })
        );
      try {
        const client = await McpOAuth.getClient(request.query.client_id);
        const redirectUri = String(request.query.redirect_uri || "");
        if (
          !client ||
          client.status !== "active" ||
          client.clientType !== "interactive"
        )
          throw Object.assign(new Error("Unknown interactive MCP client."), {
            code: "invalid_client",
            status: 401,
          });
        if (!JSON.parse(client.redirectUrisJson || "[]").includes(redirectUri))
          throw Object.assign(
            new Error("The redirect URI is not registered."),
            { code: "invalid_request" }
          );
        if (
          request.query.response_type !== "code" ||
          request.query.code_challenge_method !== "S256"
        )
          throw Object.assign(
            new Error("Authorization code with PKCE S256 is required."),
            { code: "unsupported_response_type" }
          );
        const maximumScopes = JSON.parse(client.maxScopesJson || "[]");
        const requestedScopes = String(request.query.scope || "")
          .split(/\s+/)
          .filter(Boolean);
        if (requestedScopes.some((scope) => !maximumScopes.includes(scope)))
          throw Object.assign(
            new Error("The requested OAuth scope is not permitted."),
            { code: "invalid_scope" }
          );
        const params = new URLSearchParams();
        for (const key of [
          "client_id",
          "redirect_uri",
          "response_type",
          "scope",
          "state",
          "code_challenge",
          "code_challenge_method",
        ])
          if (request.query[key] !== undefined)
            params.set(key, String(request.query[key]));
        return response.redirect(
          302,
          `/oauth/mcp/consent?${params.toString()}`
        );
      } catch (error) {
        audit("mcp.oauth.authorize.failed", {
          outcome: "failed",
          clientId: request.query.client_id,
          errorCode: error.code,
        });
        return oauthFailure(response, error);
      }
    });

    app.post(
      "/oauth/mcp/authorize",
      [validatedRequest],
      async (request, response) => {
        if (!enabled())
          return oauthFailure(
            response,
            Object.assign(new Error("External MCP is disabled."), {
              code: "temporarily_unavailable",
              status: 503,
            })
          );
        try {
          const body = reqBody(request) || {};
          const user =
            response.locals.user || (await userFromSession(request, response));
          const ownerUserId = Number(user?.id || 1);
          const client = await McpOAuth.getClient(body.client_id);
          if (
            !client ||
            client.status !== "active" ||
            client.clientType !== "interactive"
          )
            throw Object.assign(new Error("Unknown interactive MCP client."), {
              code: "invalid_client",
              status: 401,
            });
          if (
            body.response_type !== "code" ||
            body.code_challenge_method !== "S256" ||
            !/^[A-Za-z0-9_-]{43,128}$/.test(String(body.code_challenge || ""))
          )
            throw Object.assign(
              new Error("Authorization code with PKCE S256 is required."),
              { code: "invalid_request" }
            );
          if (
            !JSON.parse(client.redirectUrisJson || "[]").includes(
              String(body.redirect_uri || "")
            )
          )
            throw Object.assign(
              new Error("The redirect URI is not registered."),
              { code: "invalid_request" }
            );
          if (body.decision === "deny") {
            const redirect = new URL(String(body.redirect_uri));
            redirect.searchParams.set("error", "access_denied");
            redirect.searchParams.set(
              "error_description",
              "The resource owner denied the authorization request."
            );
            if (body.state)
              redirect.searchParams.set("state", String(body.state));
            noStore(response);
            audit("mcp.oauth.authorize.denied", {
              outcome: "denied",
              clientId: client.clientId,
              userId: ownerUserId,
            });
            return response.status(200).json({ redirect: redirect.toString() });
          }
          const maximumScopes = JSON.parse(client.maxScopesJson || "[]");
          const requestedScopes = String(body.scope || "")
            .split(/\s+/)
            .filter(Boolean);
          const effectiveScopes = requestedScopes.length
            ? [...new Set(requestedScopes)]
            : maximumScopes;
          if (effectiveScopes.some((scope) => !maximumScopes.includes(scope)))
            throw Object.assign(
              new Error("The requested OAuth scope is not permitted."),
              { code: "invalid_scope" }
            );
          const effectiveScopeSet = new Set(effectiveScopes);
          const definitionByName = new Map(
            DEFINITIONS.map((definition) => [definition.name, definition])
          );
          const selectedTools = [
            ...new Set(
              (Array.isArray(body.tools) ? body.tools : []).map(String)
            ),
          ].filter((name) =>
            effectiveScopeSet.has(definitionByName.get(name)?.scope)
          );
          const selectedScopes = [
            ...new Set(
              selectedTools
                .map((name) => definitionByName.get(name)?.scope)
                .filter(Boolean)
            ),
          ];
          const available = user
            ? await Workspace.whereWithUser(user)
            : await Workspace.where({});
          const byId = new Map(
            available.map((workspace) => [Number(workspace.id), workspace])
          );
          const workspaces = (
            Array.isArray(body.workspaceIds) ? body.workspaceIds : []
          )
            .map(Number)
            .filter((id) => byId.has(id))
            .map((id) => byId.get(id));
          const grant = await McpOAuth.createGrant({
            client,
            ownerUserId,
            ownerAuthUserId: user?.authUserId || null,
            scopes: selectedScopes,
            tools: selectedTools,
            workspaces,
            expiresInDays: body.expiresInDays,
          });
          const code = await McpOAuth.createAuthorizationCode({
            client,
            grant,
            redirectUri: body.redirect_uri,
            codeChallenge: body.code_challenge,
          });
          const redirect = new URL(String(body.redirect_uri));
          redirect.searchParams.set("code", code);
          if (body.state)
            redirect.searchParams.set("state", String(body.state));
          noStore(response);
          audit("mcp.oauth.authorize.succeeded", {
            outcome: "succeeded",
            clientId: client.clientId,
            grantId: grant.id,
            userId: ownerUserId,
          });
          return response.status(200).json({ redirect: redirect.toString() });
        } catch (error) {
          audit("mcp.oauth.authorize.failed", {
            outcome: "failed",
            clientId: request.body?.client_id,
            userId: response.locals.user?.id,
            errorCode: error.code,
          });
          return oauthFailure(response, error);
        }
      }
    );

    app.post("/oauth/mcp/token", async (request, response) => {
      if (!enabled())
        return oauthFailure(
          response,
          Object.assign(new Error("External MCP is disabled."), {
            code: "temporarily_unavailable",
            status: 503,
          })
        );
      try {
        const body = reqBody(request) || {};
        let result;
        if (body.grant_type === "authorization_code")
          result = await McpOAuth.exchangeAuthorizationCode({
            clientId: body.client_id,
            code: body.code,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
          });
        else if (body.grant_type === "client_credentials") {
          const basic = String(request.get("authorization") || "").match(
            /^Basic\s+(.+)$/i
          );
          const decoded = basic
            ? Buffer.from(basic[1], "base64").toString("utf8").split(":")
            : [];
          result = await McpOAuth.exchangeClientCredentials({
            clientId: body.client_id || decoded[0],
            clientSecret: body.client_secret || decoded.slice(1).join(":"),
            scope: body.scope,
          });
        } else if (body.grant_type === "refresh_token")
          result = await McpOAuth.rotateRefreshToken({
            clientId: body.client_id,
            refreshToken: body.refresh_token,
          });
        else
          throw Object.assign(new Error("Unsupported OAuth grant type."), {
            code: "unsupported_grant_type",
          });
        noStore(response);
        audit("mcp.oauth.token.issued", {
          outcome: "succeeded",
          clientId: body.client_id,
        });
        return response.status(200).json(result);
      } catch (error) {
        audit("mcp.oauth.token.failed", {
          outcome: "failed",
          clientId: request.body?.client_id,
          errorCode: error.code,
        });
        return oauthFailure(response, error);
      }
    });

    app.post("/oauth/mcp/revoke", async (request, response) => {
      try {
        await McpOAuth.revokeToken(
          String(reqBody(request)?.token || bearer(request))
        );
        noStore(response);
        audit("mcp.oauth.token.revoked", { outcome: "succeeded" });
        return response.sendStatus(200);
      } catch (error) {
        return oauthFailure(response, error);
      }
    });
  }

  if (includeInternal) {
    app.post("/internal/v1/mcp/introspect", async (request, response) => {
      try {
        const result = await McpOAuth.introspect(
          String(request.body?.token || "")
        );
        return response.status(200).json({ success: true, ...result });
      } catch (error) {
        return response.status(error.status || 401).json({
          success: false,
          active: false,
          error: error.code || "invalid_token",
        });
      }
    });
  }
}

module.exports = { enabled, registerExternalMcpOAuthRoutes };
