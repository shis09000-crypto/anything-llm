const crypto = require("crypto");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { ExternalMcpToolRegistry } = require("./registry");
const { canonicalJson, issueExternalMcpPrincipal } = require("./principal");
const { requestInternalService } = require("../microModules/internalClient");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const rateWindows = new Map();
const activeByClient = new Map();
const grantCache = new Map();
const idempotencyCache = new Map();
const RATE_LIMIT = 60;
const CONCURRENCY_LIMIT = 8;
const GRANT_CACHE_MS = 30_000;
const IDEMPOTENCY_MS = 2 * 60_000;

function enabled(env = process.env) {
  return (
    String(env.ATHENA_EXTERNAL_MCP_ENABLED || "false").toLowerCase() === "true"
  );
}

function bearer(request) {
  const header = String(request.get("authorization") || "");
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function origin(request) {
  return `${request.protocol}://${request.get("host")}`;
}

function authorizationServer(request, env = process.env) {
  return String(
    env.ATHENA_EXTERNAL_MCP_ISSUER || env.PUBLIC_APP_URL || origin(request)
  ).replace(/\/+$/, "");
}

function tokenKey(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function semantic(
  eventType,
  {
    principal = null,
    toolName = null,
    outcome = "observed",
    durationMs = null,
    resultSize = null,
    errorCode = null,
    requestId = null,
  } = {}
) {
  try {
    emitSemanticEvent({
      eventType,
      category: "external_mcp",
      severity:
        outcome === "failed" || outcome === "denied" ? "warning" : "info",
      outcome,
      subject: {
        type: toolName ? "mcp-tool" : "mcp-client",
        id: toolName || principal?.clientId || "unknown",
        operation: eventType,
      },
      actor: {
        type: principal?.subjectType || "client",
        id: principal?.clientId || "unknown",
      },
      correlation: { clientId: principal?.clientId, requestId },
      metadata: {
        durationMs,
        resultSize,
        errorCode,
        runId: principal?.grantId,
      },
      sensitivity: "metadata_only",
    });
  } catch {}
}

async function introspect(token, env = process.env) {
  const key = tokenKey(token);
  const cached = grantCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value;
  const identityUrl = String(env.ATHENA_IDENTITY_URL || "").replace(/\/+$/, "");
  if (identityUrl) {
    const response = await requestInternalService({
      callerRole: "external-mcp-gateway",
      targetModule: "authentication",
      capability: "identity.introspect",
      contractVersion: "1.0",
      url: `${identityUrl}/internal/v1/mcp/introspect`,
      body: { token },
      env,
      timeoutMs: 5_000,
    });
    value = {
      client: response.client,
      grant: response.grant,
      claims: response.claims,
    };
  } else {
    if (
      ["distributed", "micro-modules"].includes(
        String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      )
    )
      throw Object.assign(new Error("external_mcp_identity_unavailable"), {
        code: "EXTERNAL_MCP_IDENTITY_UNAVAILABLE",
        httpStatus: 503,
      });
    value =
      await require("../dataAccess").DataAccessCenter.externalMcpOAuth.introspect(
        token
      );
  }
  grantCache.set(key, { value, expiresAt: Date.now() + GRANT_CACHE_MS });
  return value;
}

function rateLimit(clientId) {
  const now = Date.now();
  const current = rateWindows.get(clientId);
  if (!current || current.resetAt <= now) {
    rateWindows.set(clientId, { count: 1, resetAt: now + 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > RATE_LIMIT)
    throw Object.assign(new Error("external_mcp_rate_limited"), {
      code: "EXTERNAL_MCP_RATE_LIMITED",
      httpStatus: 429,
    });
}

async function withConcurrency(clientId, handler) {
  const active = activeByClient.get(clientId) || 0;
  if (active >= CONCURRENCY_LIMIT)
    throw Object.assign(new Error("external_mcp_concurrency_limited"), {
      code: "EXTERNAL_MCP_CONCURRENCY_LIMITED",
      httpStatus: 429,
    });
  activeByClient.set(clientId, active + 1);
  try {
    return await handler();
  } finally {
    const next = Math.max(0, (activeByClient.get(clientId) || 1) - 1);
    if (next) activeByClient.set(clientId, next);
    else activeByClient.delete(clientId);
  }
}

function idempotencyKey({ clientId, requestId, toolName, args }) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson({ clientId, requestId, toolName, args }))
    .digest("hex");
}

async function invokeTool({
  principal,
  toolName,
  args,
  requestId,
  env = process.env,
}) {
  const cacheKey = idempotencyKey({
    clientId: principal.clientId,
    requestId,
    toolName,
    args,
  });
  const cached = idempotencyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const workspaceSlug = args?.workspace || null;
  const approvalRequestId = `external-mcp:${cacheKey}`;
  const assertion = issueExternalMcpPrincipal({
    grant: principal,
    clientId: principal.clientId,
    toolName,
    args,
    workspaceSlug,
    correlationId: requestId,
  });
  const brokerUrl = String(env.ATHENA_TOOL_BROKER_URL || "").replace(
    /\/+$/,
    ""
  );
  let result;
  if (brokerUrl) {
    const response = await requestInternalService({
      callerRole: "external-mcp-gateway",
      targetModule: "tool-runtime",
      capability: "tool.invoke",
      contractVersion: "1.0",
      url: `${brokerUrl}/internal/v1/external-mcp/invoke`,
      body: { approvalRequestId, toolName, args, workspaceSlug },
      principalAssertion: assertion,
      idempotencyKey: approvalRequestId,
      durableIdempotency: true,
      env,
      timeoutMs: 30_000,
    });
    result = response.result;
  } else {
    if (
      ["distributed", "micro-modules"].includes(
        String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      )
    )
      throw Object.assign(new Error("external_mcp_tool_broker_unavailable"), {
        code: "EXTERNAL_MCP_TOOL_BROKER_UNAVAILABLE",
        httpStatus: 503,
      });
    result = await ExternalMcpToolRegistry.invoke({
      toolName,
      args,
      principal,
      approvalRequestId,
    });
  }
  idempotencyCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + IDEMPOTENCY_MS,
  });
  return result;
}

function jsonRpcError(response, status, message, code = -32603) {
  if (response.headersSent) return;
  return response
    .status(status)
    .json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

async function handleMcp(request, response) {
  if (!enabled())
    return jsonRpcError(
      response,
      503,
      "Athena external MCP is disabled.",
      -32001
    );
  const token = bearer(request);
  if (!token) {
    response.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${origin(request)}/.well-known/oauth-protected-resource/mcp"`
    );
    return jsonRpcError(response, 401, "Bearer token required.", -32001);
  }
  let identity;
  try {
    identity = await introspect(token);
    identity.grant.clientId = identity.client.clientId;
    rateLimit(identity.client.clientId);
  } catch (error) {
    response.set(
      "WWW-Authenticate",
      `Bearer error="invalid_token", resource_metadata="${origin(request)}/.well-known/oauth-protected-resource/mcp"`
    );
    semantic("mcp.connection.denied", {
      outcome: "denied",
      errorCode: error.code,
    });
    return jsonRpcError(
      response,
      error.httpStatus || 401,
      "MCP authorization failed.",
      -32001
    );
  }

  const principal = { ...identity.grant, clientId: identity.client.clientId };
  const requestId = String(
    request.body?.id ?? request.get("x-request-id") ?? crypto.randomUUID()
  );
  const server = new Server(
    {
      name: "athena-external-mcp",
      version: require("../../package.json").version,
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Athena read-only tools authorized for this client and grant.",
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = ExternalMcpToolRegistry.catalog(principal);
    semantic("mcp.tools.listed", {
      principal,
      outcome: "succeeded",
      resultSize: Buffer.byteLength(JSON.stringify(tools)),
      requestId,
    });
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (rpcRequest) => {
    const startedAt = Date.now();
    const toolName = String(rpcRequest.params.name || "");
    const args = rpcRequest.params.arguments || {};
    try {
      const result = await withConcurrency(principal.clientId, () =>
        invokeTool({ principal, toolName, args, requestId })
      );
      const text = JSON.stringify(result);
      semantic("mcp.tool.succeeded", {
        principal,
        toolName,
        outcome: "succeeded",
        durationMs: Date.now() - startedAt,
        resultSize: Buffer.byteLength(text),
        requestId,
      });
      return { content: [{ type: "text", text }], structuredContent: result };
    } catch (error) {
      semantic("mcp.tool.failed", {
        principal,
        toolName,
        outcome: error.httpStatus === 403 ? "denied" : "failed",
        durationMs: Date.now() - startedAt,
        errorCode: error.code,
        requestId,
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error.code || "external_mcp_tool_failed",
              retryable: [429, 503].includes(Number(error.httpStatus)),
            }),
          },
        ],
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      Promise.resolve(transport.close()).catch(() => {});
      Promise.resolve(server.close()).catch(() => {});
    });
  } catch (error) {
    semantic("mcp.connection.failed", {
      principal,
      outcome: "failed",
      errorCode: error.code,
      requestId,
    });
    return jsonRpcError(response, 500, "MCP request failed.");
  }
}

function registerExternalMcpGatewayRoutes(app) {
  app.get("/.well-known/oauth-protected-resource/mcp", (request, response) => {
    const base = origin(request);
    response.json({
      resource: `${base}/mcp`,
      authorization_servers: [authorizationServer(request)],
      bearer_methods_supported: ["header"],
      scopes_supported: [
        ...new Set(
          ExternalMcpToolRegistry.definitions().map((tool) => tool.scope)
        ),
      ],
    });
  });
  app.get("/.well-known/oauth-authorization-server", (request, response) => {
    const base = authorizationServer(request);
    response.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/mcp/authorize`,
      token_endpoint: `${base}/oauth/mcp/token`,
      revocation_endpoint: `${base}/oauth/mcp/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
    });
  });
  app.get("/mcp", handleMcp);
  app.post("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);
  app.all("/mcp", (_request, response) => {
    response.set("Allow", "GET, POST, DELETE");
    return jsonRpcError(response, 405, "MCP method not allowed.", -32600);
  });
}

function resetExternalMcpGatewayForTests() {
  rateWindows.clear();
  activeByClient.clear();
  grantCache.clear();
  idempotencyCache.clear();
}

module.exports = {
  handleMcp,
  registerExternalMcpGatewayRoutes,
  resetExternalMcpGatewayForTests,
};
