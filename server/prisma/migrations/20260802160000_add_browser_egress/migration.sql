ALTER TABLE "browser_profiles" ADD COLUMN "networkRoute" TEXT NOT NULL DEFAULT 'system';
ALTER TABLE "browser_profiles" ADD COLUMN "preferredDriver" TEXT NOT NULL DEFAULT 'embedded';
ALTER TABLE "browser_profiles" ADD COLUMN "egressGrantId" TEXT;
ALTER TABLE "browser_profiles" ADD COLUMN "routePolicyVersion" TEXT NOT NULL DEFAULT 'browser-egress-route-v1';
ALTER TABLE "browser_profiles" ADD COLUMN "lastRouteHealth" TEXT;

CREATE TABLE "browser_egress_grants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerUserId" INTEGER NOT NULL,
  "profileId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "region" TEXT NOT NULL DEFAULT 'overseas',
  "gatewayId" TEXT,
  "credentialRef" TEXT,
  "configVersion" TEXT,
  "quotaConnections" INTEGER NOT NULL DEFAULT 8,
  "quotaBytes" BIGINT,
  "issuedAt" DATETIME,
  "expiresAt" DATETIME,
  "revokedAt" DATETIME,
  "lastHandshakeAt" DATETIME,
  "lastHealthCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "browser_egress_grants_ownerUserId_profileId_deviceId_key"
  ON "browser_egress_grants"("ownerUserId", "profileId", "deviceId");
CREATE INDEX "browser_egress_grants_ownerUserId_state_idx"
  ON "browser_egress_grants"("ownerUserId", "state");
CREATE INDEX "browser_egress_grants_deviceId_state_idx"
  ON "browser_egress_grants"("deviceId", "state");
CREATE INDEX "browser_egress_grants_expiresAt_idx"
  ON "browser_egress_grants"("expiresAt");
