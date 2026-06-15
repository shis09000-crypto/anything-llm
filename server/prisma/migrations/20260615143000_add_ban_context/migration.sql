ALTER TABLE "users" ADD COLUMN "previousRole" TEXT;
ALTER TABLE "users" ADD COLUMN "previousAllowedEnvs" TEXT;
ALTER TABLE "users" ADD COLUMN "previousOwnerType" TEXT;
ALTER TABLE "users" ADD COLUMN "banActorRole" TEXT;
ALTER TABLE "users" ADD COLUMN "banActorOwnerType" TEXT;
ALTER TABLE "users" ADD COLUMN "banActorAuthUserId" INTEGER;
ALTER TABLE "users" ADD COLUMN "bannedAt" DATETIME;
