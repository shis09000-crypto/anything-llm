ALTER TABLE "users" ADD COLUMN "displayName" TEXT;
ALTER TABLE "users" ADD COLUMN "phone" TEXT;
ALTER TABLE "users" ADD COLUMN "phone_verified_at" DATETIME;

UPDATE "users"
SET "displayName" = "username"
WHERE "displayName" IS NULL AND "username" IS NOT NULL;

CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
