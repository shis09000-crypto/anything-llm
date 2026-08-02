CREATE TABLE "crypto_account_equity_snapshots" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "authUserId" INTEGER NOT NULL,
  "sampleBucket" INTEGER NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL,
  "apiTotalUsd" TEXT NOT NULL,
  "unrealizedPnlUsd" TEXT NOT NULL,
  "netEquityUsd" TEXT NOT NULL,
  "accountSumUsd" TEXT NOT NULL,
  "breakdownJson" TEXT NOT NULL DEFAULT '{}',
  "source" TEXT NOT NULL DEFAULT 'protected_sampler',
  "quality" TEXT NOT NULL DEFAULT 'observed',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "crypto_account_equity_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crypto_account_equity_snapshots_connectionId_sampleBucket_key"
ON "crypto_account_equity_snapshots"("connectionId", "sampleBucket");

CREATE INDEX "crypto_account_equity_snapshots_connectionId_sampledAt_idx"
ON "crypto_account_equity_snapshots"("connectionId", "sampledAt");

CREATE INDEX "crypto_account_equity_snapshots_authUserId_sampledAt_idx"
ON "crypto_account_equity_snapshots"("authUserId", "sampledAt");
