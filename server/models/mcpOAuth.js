const crypto = require("crypto");
const authPrisma = require("../utils/authPrisma");
const {
  hashPassword,
  verifyPassword,
} = require("../utils/security/passwordCredential");
const {
  remoteKeyCustodyEnabled,
  remoteMcpTokenDescriptor,
  remoteSignMcpAccessToken,
} = require("../utils/security/keyCustody/remoteClient");

const ACCESS_AUDIENCE = "athena-external-mcp";
const TOKEN_ISSUER = "athena-identity";
const ACCESS_TTL_SECONDS = 10 * 60;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLIENT_SECRET_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function tokenIssuer(env = process.env) {
  return String(
    env.ATHENA_EXTERNAL_MCP_ISSUER || env.PUBLIC_APP_URL || TOKEN_ISSUER
  ).replace(/\/+$/, "");
}

function opaqueToken(prefix, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

function tokenHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizedStrings(value, max = 128) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(String)
        .map((v) => v.trim())
        .filter(Boolean)
    ),
  ].slice(0, max);
}

function publicClient(client) {
  if (!client) return null;
  const { secretHash: _secretHash, ...safe } = client;
  return {
    ...safe,
    redirectUris: jsonArray(client.redirectUrisJson),
    maxScopes: jsonArray(client.maxScopesJson),
    maxTools: jsonArray(client.maxToolsJson),
    maxWorkspaces: jsonArray(client.maxWorkspacesJson),
  };
}

function oauthError(code, description, status = 400) {
  const error = new Error(description || code);
  error.code = code;
  error.status = status;
  return error;
}

async function grantDetails(grantId) {
  const grant = await authPrisma.mcp_access_grants.findUnique({
    where: { id: String(grantId) },
  });
  if (!grant) return null;
  const [scopeRows, toolRows, workspaceRows] = await Promise.all([
    authPrisma.mcp_grant_scopes.findMany({ where: { grantId: grant.id } }),
    authPrisma.mcp_grant_tools.findMany({ where: { grantId: grant.id } }),
    authPrisma.mcp_grant_workspaces.findMany({ where: { grantId: grant.id } }),
  ]);
  return {
    ...grant,
    scopes: scopeRows.map((row) => row.scope),
    tools: toolRows.map((row) => row.toolName),
    workspaces: workspaceRows.map((row) => ({
      id: row.workspaceId,
      slug: row.workspaceSlug,
    })),
  };
}

function assertGrantActive(grant) {
  if (!grant || grant.status !== "active")
    throw oauthError("invalid_grant", "The MCP grant is not active.", 401);
  if (new Date(grant.expiresAt).getTime() <= Date.now())
    throw oauthError("invalid_grant", "The MCP grant has expired.", 401);
}

function custodySigningRequired(env = process.env) {
  return (
    env.NODE_ENV === "production" ||
    String(env.ATHENA_EXTERNAL_MCP_FORCE_CUSTODY || "false") === "true"
  );
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodedJson(value) {
  return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
}

function tokenPayload(client, grant, env = process.env) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    typ: "athena-mcp-access",
    iss: tokenIssuer(env),
    aud: ACCESS_AUDIENCE,
    sub: `${grant.subjectType}:${grant.ownerUserId}`,
    client_id: client.clientId,
    grant_id: grant.id,
    grant_version: grant.authorizationVersion,
    scope: grant.scopes.join(" "),
    iat: issuedAt,
    exp: issuedAt + ACCESS_TTL_SECONDS,
  };
}

function developmentSigningSecret(env = process.env) {
  const root = String(
    env.ATHENA_EXTERNAL_MCP_DEV_TOKEN_SECRET || env.JWT_SECRET || ""
  );
  if (!root)
    throw oauthError(
      "temporarily_unavailable",
      "MCP development token signing is unavailable.",
      503
    );
  return crypto
    .createHmac("sha256", root)
    .update("athena-external-mcp-development-token-v1", "utf8")
    .digest();
}

function issueDevelopmentAccessToken(client, grant, env = process.env) {
  const signingInput = `${encodedJson({
    alg: "HS256",
    typ: "at+jwt",
    kid: "athena-mcp-development-v1",
  })}.${encodedJson(tokenPayload(client, grant, env))}`;
  const signature = crypto
    .createHmac("sha256", developmentSigningSecret(env))
    .update(signingInput, "utf8")
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

async function issueAccessToken(client, grant, env = process.env) {
  if (!custodySigningRequired(env))
    return issueDevelopmentAccessToken(client, grant, env);
  const custodyContext = { purpose: "mcp-access-token" };
  if (!remoteKeyCustodyEnabled(env, custodyContext))
    throw oauthError(
      "temporarily_unavailable",
      "MCP token signing custody is unavailable.",
      503
    );
  const descriptor = await remoteMcpTokenDescriptor(null, env);
  const signingInput = `${encodedJson({
    alg: "EdDSA",
    typ: "at+jwt",
    kid: descriptor.keyId,
  })}.${encodedJson(tokenPayload(client, grant, env))}`;
  const signed = await remoteSignMcpAccessToken(
    { keyId: descriptor.keyId, signingInput },
    env
  );
  return `${signingInput}.${signed.signature}`;
}

async function verifyAccessToken(token, env = process.env) {
  const raw = String(token || "");
  const parts = raw.split(".");
  if (parts.length !== 3)
    throw oauthError("invalid_token", "The MCP access token is invalid.", 401);
  let header;
  let claims;
  try {
    header = decodedJson(parts[0]);
    claims = decodedJson(parts[1]);
  } catch {
    throw oauthError("invalid_token", "The MCP access token is invalid.", 401);
  }
  if (header.alg === "EdDSA") {
    if (header.typ !== "at+jwt" || !String(header.kid || "").trim())
      throw oauthError(
        "invalid_token",
        "The MCP access token is invalid.",
        401
      );
    if (!custodySigningRequired(env))
      throw oauthError(
        "invalid_token",
        "The MCP access token is invalid.",
        401
      );
    const descriptor = await remoteMcpTokenDescriptor(header.kid, env);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(descriptor.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (
      !crypto.verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
        publicKey,
        Buffer.from(parts[2], "base64url")
      )
    )
      throw oauthError(
        "invalid_token",
        "The MCP access token is invalid.",
        401
      );
  } else {
    if (custodySigningRequired(env))
      throw oauthError(
        "invalid_token",
        "The MCP access token is invalid.",
        401
      );
    if (
      header.alg !== "HS256" ||
      header.typ !== "at+jwt" ||
      header.kid !== "athena-mcp-development-v1"
    )
      throw oauthError(
        "invalid_token",
        "The MCP access token is invalid.",
        401
      );
    const expected = crypto
      .createHmac("sha256", developmentSigningSecret(env))
      .update(`${parts[0]}.${parts[1]}`, "utf8")
      .digest();
    let supplied;
    try {
      supplied = Buffer.from(parts[2], "base64url");
    } catch {
      supplied = Buffer.alloc(0);
    }
    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(supplied, expected)
    )
      throw oauthError(
        "invalid_token",
        "The MCP access token is invalid.",
        401
      );
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.typ !== "athena-mcp-access" ||
    claims.aud !== ACCESS_AUDIENCE ||
    claims.iss !== tokenIssuer(env) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > now + 30 ||
    claims.exp <= now ||
    claims.exp - claims.iat > ACCESS_TTL_SECONDS + 60
  )
    throw oauthError("invalid_token", "The MCP access token is invalid.", 401);
  return claims;
}

async function createRefreshToken(
  client,
  grant,
  tokenFamily = crypto.randomUUID(),
  parentTokenId = null
) {
  const plain = opaqueToken("mcp_rt", 40);
  const record = await authPrisma.mcp_refresh_tokens.create({
    data: {
      tokenHash: tokenHash(plain),
      tokenFamily,
      clientId: client.clientId,
      grantId: grant.id,
      parentTokenId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { plain, record };
}

async function tokenResponse(
  client,
  grant,
  { includeRefresh = false, tokenFamily = null, parentTokenId = null } = {}
) {
  const accessToken = await issueAccessToken(client, grant);
  const refresh = includeRefresh
    ? await createRefreshToken(
        client,
        grant,
        tokenFamily || undefined,
        parentTokenId
      )
    : null;
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    scope: grant.scopes.join(" "),
    ...(refresh
      ? { refresh_token: refresh.plain, refreshRecord: refresh.record }
      : {}),
  };
}

async function replaceGrantCollections(
  tx,
  grantId,
  { scopes, tools, workspaces }
) {
  await Promise.all([
    tx.mcp_grant_scopes.deleteMany({ where: { grantId } }),
    tx.mcp_grant_tools.deleteMany({ where: { grantId } }),
    tx.mcp_grant_workspaces.deleteMany({ where: { grantId } }),
  ]);
  // Prisma 5.3 does not expose createMany for SQLite. Keep this transaction
  // provider-neutral so the same OAuth contract works in local and PG builds.
  await Promise.all(
    scopes.map((scope) =>
      tx.mcp_grant_scopes.create({ data: { grantId, scope } })
    )
  );
  await Promise.all(
    tools.map((toolName) =>
      tx.mcp_grant_tools.create({ data: { grantId, toolName } })
    )
  );
  await Promise.all(
    workspaces.map((workspace) =>
      tx.mcp_grant_workspaces.create({
        data: {
          grantId,
          workspaceId: Number(workspace.id),
          workspaceSlug: String(workspace.slug),
        },
      })
    )
  );
}

const McpOAuth = {
  ACCESS_AUDIENCE,
  TOKEN_ISSUER,
  tokenIssuer,

  async createClient({
    name,
    clientType,
    redirectUris = [],
    maxScopes = [],
    maxTools = [],
    maxWorkspaces = [],
    createdByUserId,
    createdByAuthUserId = null,
  }) {
    const type = String(clientType || "").trim();
    if (!name || !["interactive", "service"].includes(type))
      throw oauthError(
        "invalid_client_metadata",
        "A name and valid client type are required."
      );
    const uris = normalizedStrings(redirectUris, 16);
    if (type === "interactive" && !uris.length)
      throw oauthError(
        "invalid_redirect_uri",
        "Interactive clients require an exact redirect URI."
      );
    for (const uri of uris) {
      let parsed;
      try {
        parsed = new URL(uri);
      } catch {
        throw oauthError("invalid_redirect_uri", "A redirect URI is invalid.");
      }
      if (!["https:", "http:"].includes(parsed.protocol))
        throw oauthError(
          "invalid_redirect_uri",
          "Only HTTP(S) redirect URIs are allowed."
        );
      if (parsed.hash)
        throw oauthError(
          "invalid_redirect_uri",
          "Redirect URIs cannot include a fragment."
        );
    }

    const clientId = opaqueToken("athena_mcp", 18);
    const clientSecret = type === "service" ? opaqueToken("mcp_cs", 40) : null;
    const secretHash = clientSecret ? await hashPassword(clientSecret) : null;
    const client = await authPrisma.mcp_oauth_clients.create({
      data: {
        clientId,
        name: String(name).trim().slice(0, 120),
        clientType: type,
        secretHash,
        redirectUrisJson: JSON.stringify(uris),
        maxScopesJson: JSON.stringify(normalizedStrings(maxScopes)),
        maxToolsJson: JSON.stringify(normalizedStrings(maxTools)),
        maxWorkspacesJson: JSON.stringify(normalizedStrings(maxWorkspaces)),
        createdByUserId: Number(createdByUserId),
        createdByAuthUserId: createdByAuthUserId
          ? String(createdByAuthUserId)
          : null,
        secretExpiresAt: clientSecret
          ? new Date(Date.now() + CLIENT_SECRET_TTL_MS)
          : null,
      },
    });
    return { client: publicClient(client), clientSecret };
  },

  async listClients({ createdByUserId = null } = {}) {
    const rows = await authPrisma.mcp_oauth_clients.findMany({
      where: createdByUserId
        ? { createdByUserId: Number(createdByUserId) }
        : {},
      orderBy: { createdAt: "desc" },
    });
    return rows.map(publicClient);
  },

  async getClient(clientId) {
    return authPrisma.mcp_oauth_clients.findUnique({
      where: { clientId: String(clientId) },
    });
  },

  async rotateClientSecret(clientId, actorUserId) {
    const client = await this.getClient(clientId);
    if (
      !client ||
      client.createdByUserId !== Number(actorUserId) ||
      client.clientType !== "service"
    )
      throw oauthError(
        "invalid_client",
        "The service client was not found.",
        404
      );
    const clientSecret = opaqueToken("mcp_cs", 40);
    const updated = await authPrisma.mcp_oauth_clients.update({
      where: { clientId: client.clientId },
      data: {
        secretHash: await hashPassword(clientSecret),
        secretExpiresAt: new Date(Date.now() + CLIENT_SECRET_TTL_MS),
        status: "active",
      },
    });
    return { client: publicClient(updated), clientSecret };
  },

  async setClientStatus(clientId, status, actorUserId) {
    const client = await this.getClient(clientId);
    if (!client || client.createdByUserId !== Number(actorUserId))
      throw oauthError("invalid_client", "The MCP client was not found.", 404);
    if (!new Set(["active", "disabled"]).has(status))
      throw oauthError(
        "invalid_request",
        "The requested client status is invalid."
      );
    const updated = await authPrisma.$transaction(async (tx) => {
      const row = await tx.mcp_oauth_clients.update({
        where: { clientId: client.clientId },
        data: { status },
      });
      if (status === "disabled") {
        await tx.mcp_access_grants.updateMany({
          where: { clientId: client.clientId, status: "active" },
          data: {
            status: "revoked",
            revokedAt: new Date(),
            revokedByUserId: Number(actorUserId),
            revokeReason: "client_disabled",
          },
        });
        await tx.mcp_refresh_tokens.updateMany({
          where: { clientId: client.clientId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return row;
    });
    return publicClient(updated);
  },

  async createGrant({
    client,
    ownerUserId,
    ownerAuthUserId = null,
    scopes = [],
    tools = [],
    workspaces = [],
    expiresInDays = 30,
  }) {
    if (!client || client.status !== "active")
      throw oauthError("invalid_client", "The MCP client is not active.", 401);
    const allowedScopes = new Set(jsonArray(client.maxScopesJson));
    const allowedTools = new Set(jsonArray(client.maxToolsJson));
    const allowedWorkspaces = new Set(
      jsonArray(client.maxWorkspacesJson).map(
        (value) => String(value).split(":", 1)[0]
      )
    );
    const selectedScopes = normalizedStrings(scopes).filter((value) =>
      allowedScopes.has(value)
    );
    const selectedTools = normalizedStrings(tools).filter((value) =>
      allowedTools.has(value)
    );
    const selectedWorkspaces = (
      Array.isArray(workspaces) ? workspaces : []
    ).filter(
      (workspace) =>
        workspace?.id &&
        workspace?.slug &&
        allowedWorkspaces.has(String(workspace.id))
    );
    if (!selectedScopes.length || !selectedTools.length)
      throw oauthError(
        "invalid_scope",
        "At least one permitted scope and tool are required."
      );
    const ttl = Math.min(
      Math.max(Number(expiresInDays) || 30, 1) * 24 * 60 * 60 * 1000,
      MAX_GRANT_TTL_MS
    );
    const grant = await authPrisma.$transaction(async (tx) => {
      const created = await tx.mcp_access_grants.create({
        data: {
          clientId: client.clientId,
          subjectType: client.clientType === "service" ? "service" : "user",
          ownerUserId: Number(ownerUserId),
          ownerAuthUserId: ownerAuthUserId ? String(ownerAuthUserId) : null,
          expiresAt: new Date(Date.now() + ttl),
        },
      });
      await replaceGrantCollections(tx, created.id, {
        scopes: selectedScopes,
        tools: selectedTools,
        workspaces: selectedWorkspaces,
      });
      return created;
    });
    return grantDetails(grant.id);
  },

  async ensureServiceGrant(client) {
    const existing = await authPrisma.mcp_access_grants.findFirst({
      where: {
        clientId: client.clientId,
        subjectType: "service",
        status: "active",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return grantDetails(existing.id);
    return this.createGrant({
      client,
      ownerUserId: client.createdByUserId,
      ownerAuthUserId: client.createdByAuthUserId,
      scopes: jsonArray(client.maxScopesJson),
      tools: jsonArray(client.maxToolsJson),
      workspaces: jsonArray(client.maxWorkspacesJson).map((value) => {
        const [id, ...slug] = String(value).split(":");
        return { id: Number(id), slug: slug.join(":") || String(value) };
      }),
      expiresInDays: 30,
    });
  },

  async createAuthorizationCode({ client, grant, redirectUri, codeChallenge }) {
    if (!jsonArray(client.redirectUrisJson).includes(String(redirectUri)))
      throw oauthError(
        "invalid_redirect_uri",
        "The redirect URI does not match the registered client."
      );
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(String(codeChallenge || "")))
      throw oauthError(
        "invalid_request",
        "PKCE S256 code_challenge is required."
      );
    const plain = opaqueToken("mcp_ac", 32);
    await authPrisma.mcp_authorization_codes.create({
      data: {
        codeHash: tokenHash(plain),
        clientId: client.clientId,
        grantId: grant.id,
        redirectUri: String(redirectUri),
        codeChallenge: String(codeChallenge),
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      },
    });
    return plain;
  },

  async exchangeAuthorizationCode({
    clientId,
    code,
    redirectUri,
    codeVerifier,
  }) {
    const client = await this.getClient(clientId);
    if (
      !client ||
      client.status !== "active" ||
      client.clientType !== "interactive"
    )
      throw oauthError(
        "invalid_client",
        "The interactive client is invalid.",
        401
      );
    const challenge = crypto
      .createHash("sha256")
      .update(String(codeVerifier || ""))
      .digest("base64url");
    const record = await authPrisma.$transaction(async (tx) => {
      const current = await tx.mcp_authorization_codes.findUnique({
        where: { codeHash: tokenHash(code) },
      });
      if (
        !current ||
        current.clientId !== client.clientId ||
        current.redirectUri !== String(redirectUri) ||
        current.consumedAt ||
        current.expiresAt <= new Date() ||
        current.codeChallenge !== challenge
      )
        throw oauthError(
          "invalid_grant",
          "The authorization code or PKCE verifier is invalid.",
          401
        );
      const consumed = await tx.mcp_authorization_codes.updateMany({
        where: {
          id: current.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw oauthError(
          "invalid_grant",
          "The authorization code or PKCE verifier is invalid.",
          401
        );
      return { ...current, consumedAt: new Date() };
    });
    const grant = await grantDetails(record.grantId);
    assertGrantActive(grant);
    const response = await tokenResponse(client, grant, {
      includeRefresh: true,
    });
    delete response.refreshRecord;
    return response;
  },

  async exchangeClientCredentials({ clientId, clientSecret, scope = "" }) {
    const client = await this.getClient(clientId);
    if (
      !client ||
      client.status !== "active" ||
      client.clientType !== "service" ||
      !client.secretHash
    )
      throw oauthError("invalid_client", "The service client is invalid.", 401);
    if (client.secretExpiresAt && client.secretExpiresAt <= new Date())
      throw oauthError(
        "invalid_client",
        "The service client secret has expired.",
        401
      );
    const verified = await verifyPassword(clientSecret, client.secretHash);
    if (!verified.valid)
      throw oauthError(
        "invalid_client",
        "The service client credentials are invalid.",
        401
      );
    const grant = await this.ensureServiceGrant(client);
    assertGrantActive(grant);
    const requested = normalizedStrings(String(scope || "").split(/\s+/));
    if (
      requested.length &&
      requested.some((value) => !grant.scopes.includes(value))
    )
      throw oauthError("invalid_scope", "The requested scope is not granted.");
    return tokenResponse(client, grant);
  },

  async rotateRefreshToken({ clientId, refreshToken }) {
    const client = await this.getClient(clientId);
    if (
      !client ||
      client.status !== "active" ||
      client.clientType !== "interactive"
    )
      throw oauthError(
        "invalid_client",
        "The interactive client is invalid.",
        401
      );
    const current = await authPrisma.mcp_refresh_tokens.findUnique({
      where: { tokenHash: tokenHash(refreshToken) },
    });
    if (
      !current ||
      current.clientId !== client.clientId ||
      current.expiresAt <= new Date() ||
      current.revokedAt
    )
      throw oauthError("invalid_grant", "The refresh token is invalid.", 401);
    if (current.consumedAt) {
      await authPrisma.mcp_refresh_tokens.updateMany({
        where: { tokenFamily: current.tokenFamily, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw oauthError(
        "invalid_grant",
        "Refresh token reuse was detected.",
        401
      );
    }
    const claimed = await authPrisma.mcp_refresh_tokens.updateMany({
      where: {
        id: current.id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await authPrisma.mcp_refresh_tokens.updateMany({
        where: { tokenFamily: current.tokenFamily, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw oauthError(
        "invalid_grant",
        "Refresh token reuse was detected.",
        401
      );
    }
    const grant = await grantDetails(current.grantId);
    assertGrantActive(grant);
    const next = await tokenResponse(client, grant, {
      includeRefresh: true,
      tokenFamily: current.tokenFamily,
      parentTokenId: current.id,
    });
    await authPrisma.mcp_refresh_tokens.update({
      where: { id: current.id },
      data: {
        replacedByTokenId: next.refreshRecord.id,
      },
    });
    delete next.refreshRecord;
    return next;
  },

  async introspect(accessToken) {
    const claims = await verifyAccessToken(accessToken);
    if (claims.typ !== "athena-mcp-access")
      throw oauthError(
        "invalid_token",
        "The token is not an MCP access token.",
        401
      );
    const [client, grant] = await Promise.all([
      this.getClient(claims.client_id),
      grantDetails(claims.grant_id),
    ]);
    if (!client || client.status !== "active")
      throw oauthError("invalid_token", "The MCP client is disabled.", 401);
    assertGrantActive(grant);
    if (Number(claims.grant_version) !== Number(grant.authorizationVersion))
      throw oauthError(
        "invalid_token",
        "The MCP grant version has changed.",
        401
      );
    return { claims, client: publicClient(client), grant };
  },

  async listGrants({ ownerUserId = null } = {}) {
    const rows = await authPrisma.mcp_access_grants.findMany({
      where: ownerUserId ? { ownerUserId: Number(ownerUserId) } : {},
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((row) => grantDetails(row.id)));
  },

  async revokeGrant(grantId, actorUserId, reason = "user_revoked") {
    const grant = await grantDetails(grantId);
    if (!grant || grant.ownerUserId !== Number(actorUserId))
      throw oauthError("invalid_grant", "The MCP grant was not found.", 404);
    await authPrisma.$transaction(async (tx) => {
      await tx.mcp_access_grants.update({
        where: { id: grant.id },
        data: {
          status: "revoked",
          revokedAt: new Date(),
          revokedByUserId: Number(actorUserId),
          revokeReason: String(reason).slice(0, 120),
        },
      });
      await tx.mcp_refresh_tokens.updateMany({
        where: { grantId: grant.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return true;
  },

  async emergencyRevokeAll(actorUserId) {
    const now = new Date();
    return authPrisma.$transaction(async (tx) => {
      const grants = await tx.mcp_access_grants.updateMany({
        where: { status: "active" },
        data: {
          status: "revoked",
          revokedAt: now,
          revokedByUserId: Number(actorUserId),
          revokeReason: "global_emergency_revoke",
        },
      });
      await tx.mcp_refresh_tokens.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: now },
      });
      return grants.count;
    });
  },

  async revokeToken(token) {
    const hash = tokenHash(token);
    const refresh = await authPrisma.mcp_refresh_tokens.findUnique({
      where: { tokenHash: hash },
    });
    if (refresh) {
      await authPrisma.mcp_refresh_tokens.updateMany({
        where: { tokenFamily: refresh.tokenFamily, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return true;
    }
    try {
      const claims = await verifyAccessToken(token);
      const grant = await grantDetails(claims.grant_id);
      if (grant)
        await authPrisma.mcp_access_grants.update({
          where: { id: grant.id },
          data: {
            status: "revoked",
            revokedAt: new Date(),
            revokeReason: "token_revoked",
          },
        });
    } catch {}
    return true;
  },
};

module.exports = {
  McpOAuth,
  oauthError,
  publicClient,
  tokenHash,
  _internals: {
    issueAccessToken,
    tokenIssuer,
    verifyAccessToken,
  },
};
