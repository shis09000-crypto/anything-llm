CREATE TABLE "auth_realtime_tickets" (
  "ticketHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "appEnv" TEXT NOT NULL,
  "resourceId" TEXT,
  "claimsJson" TEXT NOT NULL,
  "multiUser" BOOLEAN NOT NULL,
  "clientId" TEXT,
  "authUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),

  CONSTRAINT "auth_realtime_tickets_pkey" PRIMARY KEY ("ticketHash")
);

CREATE INDEX "auth_realtime_tickets_expiresAt_idx"
ON "auth_realtime_tickets"("expiresAt");

CREATE INDEX "auth_realtime_tickets_appEnv_expiresAt_idx"
ON "auth_realtime_tickets"("appEnv", "expiresAt");

CREATE INDEX "auth_realtime_tickets_authUserId_consumedAt_idx"
ON "auth_realtime_tickets"("authUserId", "consumedAt");

ALTER TABLE "auth_realtime_tickets"
ADD CONSTRAINT "auth_realtime_tickets_authUserId_fkey"
FOREIGN KEY ("authUserId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
