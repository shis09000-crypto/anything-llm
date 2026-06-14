ALTER TABLE "invites" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "invites" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "invites" ADD COLUMN "createdByAdminId" INTEGER;
ALTER TABLE "invites" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "invites" ADD COLUMN "consumedAt" DATETIME;
ALTER TABLE "invites" ADD COLUMN "revokedAt" DATETIME;
ALTER TABLE "invites" ADD COLUMN "usedByUserId" INTEGER;

CREATE UNIQUE INDEX "invites_tokenHash_key" ON "invites"("tokenHash");
CREATE INDEX "invites_tokenHash_idx" ON "invites"("tokenHash");
CREATE INDEX "invites_role_idx" ON "invites"("role");
CREATE INDEX "invites_expiresAt_idx" ON "invites"("expiresAt");
CREATE INDEX "invites_consumedAt_idx" ON "invites"("consumedAt");
CREATE INDEX "invites_revokedAt_idx" ON "invites"("revokedAt");
