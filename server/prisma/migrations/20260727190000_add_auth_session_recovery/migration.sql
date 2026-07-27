ALTER TABLE "auth_sessions" ADD COLUMN "recoveryHandleHash" TEXT;
ALTER TABLE "auth_sessions" ADD COLUMN "recoveryEnabledAt" DATETIME;
ALTER TABLE "auth_sessions" ADD COLUMN "recoveryLastUsedAt" DATETIME;

CREATE UNIQUE INDEX "auth_sessions_recoveryHandleHash_key"
ON "auth_sessions"("recoveryHandleHash");
