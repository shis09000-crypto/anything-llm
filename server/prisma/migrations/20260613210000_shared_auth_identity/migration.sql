ALTER TABLE "users" ADD COLUMN "authUserId" INTEGER;
ALTER TABLE "users" ADD COLUMN "originEnv" TEXT;

CREATE UNIQUE INDEX "users_authUserId_key" ON "users"("authUserId");
CREATE INDEX "users_originEnv_idx" ON "users"("originEnv");
