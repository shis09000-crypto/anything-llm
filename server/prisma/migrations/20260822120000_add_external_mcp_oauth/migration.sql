ALTER TABLE "api_keys" ADD COLUMN "lastUsedAt" DATETIME;

CREATE TABLE "mcp_oauth_clients" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "clientType" TEXT NOT NULL,
  "secretHash" TEXT,
  "redirectUrisJson" TEXT NOT NULL DEFAULT '[]',
  "maxScopesJson" TEXT NOT NULL DEFAULT '[]',
  "maxToolsJson" TEXT NOT NULL DEFAULT '[]',
  "maxWorkspacesJson" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'active',
  "policyVersion" TEXT NOT NULL DEFAULT 'external-mcp-v1',
  "createdByUserId" INTEGER NOT NULL,
  "createdByAuthUserId" TEXT,
  "secretExpiresAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "mcp_oauth_clients_clientId_key" ON "mcp_oauth_clients"("clientId");
CREATE INDEX "mcp_oauth_clients_createdByUserId_status_idx" ON "mcp_oauth_clients"("createdByUserId", "status");
CREATE INDEX "mcp_oauth_clients_status_secretExpiresAt_idx" ON "mcp_oauth_clients"("status", "secretExpiresAt");

CREATE TABLE "mcp_access_grants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "ownerUserId" INTEGER NOT NULL,
  "ownerAuthUserId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "authorizationVersion" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  "revokedByUserId" INTEGER,
  "revokeReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "mcp_access_grants_clientId_status_expiresAt_idx" ON "mcp_access_grants"("clientId", "status", "expiresAt");
CREATE INDEX "mcp_access_grants_ownerUserId_status_idx" ON "mcp_access_grants"("ownerUserId", "status");

CREATE TABLE "mcp_grant_scopes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "grantId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "mcp_grant_scopes_grantId_scope_key" ON "mcp_grant_scopes"("grantId", "scope");
CREATE INDEX "mcp_grant_scopes_grantId_idx" ON "mcp_grant_scopes"("grantId");

CREATE TABLE "mcp_grant_tools" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "grantId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "mcp_grant_tools_grantId_toolName_key" ON "mcp_grant_tools"("grantId", "toolName");
CREATE INDEX "mcp_grant_tools_grantId_idx" ON "mcp_grant_tools"("grantId");

CREATE TABLE "mcp_grant_workspaces" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "grantId" TEXT NOT NULL,
  "workspaceId" INTEGER NOT NULL,
  "workspaceSlug" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "mcp_grant_workspaces_grantId_workspaceId_key" ON "mcp_grant_workspaces"("grantId", "workspaceId");
CREATE INDEX "mcp_grant_workspaces_grantId_idx" ON "mcp_grant_workspaces"("grantId");
CREATE INDEX "mcp_grant_workspaces_workspaceId_idx" ON "mcp_grant_workspaces"("workspaceId");

CREATE TABLE "mcp_authorization_codes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "codeHash" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "codeChallenge" TEXT NOT NULL,
  "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "mcp_authorization_codes_codeHash_key" ON "mcp_authorization_codes"("codeHash");
CREATE INDEX "mcp_authorization_codes_clientId_expiresAt_idx" ON "mcp_authorization_codes"("clientId", "expiresAt");
CREATE INDEX "mcp_authorization_codes_grantId_idx" ON "mcp_authorization_codes"("grantId");

CREATE TABLE "mcp_refresh_tokens" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "tokenFamily" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "parentTokenId" TEXT,
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "revokedAt" DATETIME,
  "replacedByTokenId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "mcp_refresh_tokens_tokenHash_key" ON "mcp_refresh_tokens"("tokenHash");
CREATE INDEX "mcp_refresh_tokens_tokenFamily_revokedAt_idx" ON "mcp_refresh_tokens"("tokenFamily", "revokedAt");
CREATE INDEX "mcp_refresh_tokens_clientId_grantId_idx" ON "mcp_refresh_tokens"("clientId", "grantId");
CREATE INDEX "mcp_refresh_tokens_expiresAt_idx" ON "mcp_refresh_tokens"("expiresAt");
