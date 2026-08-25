CREATE TABLE "crypto_account_supplemental_holdings" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "authUserId" INTEGER NOT NULL,
  "symbol" TEXT NOT NULL,
  "quantity" TEXT NOT NULL,
  "costBasisUsd" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'user_supplied',
  "status" TEXT NOT NULL DEFAULT 'active',
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crypto_account_supplemental_holdings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crypto_account_supplemental_holdings_connectionId_symbol_key"
ON "crypto_account_supplemental_holdings"("connectionId", "symbol");

CREATE INDEX "crypto_account_supplemental_holdings_authUserId_status_idx"
ON "crypto_account_supplemental_holdings"("authUserId", "status");

CREATE INDEX "crypto_account_supplemental_holdings_connectionId_status_idx"
ON "crypto_account_supplemental_holdings"("connectionId", "status");

INSERT INTO "crypto_account_supplemental_holdings"
  ("id", "connectionId", "userId", "authUserId", "symbol", "quantity", "costBasisUsd", "source", "status", "effectiveAt")
SELECT
  'crypto_supplemental_' || "id" || '_USDT', "id", "userId", "authUserId",
  'USDT', '15000', '15000', 'user_supplied_migration', 'active', CURRENT_TIMESTAMP
FROM "crypto_account_connections"
WHERE "revokedAt" IS NULL;

INSERT INTO "crypto_account_supplemental_holdings"
  ("id", "connectionId", "userId", "authUserId", "symbol", "quantity", "costBasisUsd", "source", "status", "effectiveAt")
SELECT
  'crypto_supplemental_' || "id" || '_BTC', "id", "userId", "authUserId",
  'BTC', '0.19069896', '13235.08', 'user_supplied_migration', 'active', CURRENT_TIMESTAMP
FROM "crypto_account_connections"
WHERE "revokedAt" IS NULL;

INSERT INTO "crypto_account_supplemental_holdings"
  ("id", "connectionId", "userId", "authUserId", "symbol", "quantity", "costBasisUsd", "source", "status", "effectiveAt")
SELECT
  'crypto_supplemental_' || "id" || '_ETH', "id", "userId", "authUserId",
  'ETH', '5.89370466', '13235.08', 'user_supplied_migration', 'active', CURRENT_TIMESTAMP
FROM "crypto_account_connections"
WHERE "revokedAt" IS NULL;
