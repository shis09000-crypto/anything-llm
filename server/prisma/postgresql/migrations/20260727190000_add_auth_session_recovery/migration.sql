ALTER TABLE "auth_sessions"
  ADD COLUMN "recoveryHandleHash" TEXT,
  ADD COLUMN "recoveryEnabledAt" TIMESTAMP(3),
  ADD COLUMN "recoveryLastUsedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "auth_sessions_recoveryHandleHash_key"
ON "auth_sessions"("recoveryHandleHash");
