ALTER TABLE "users" ADD COLUMN "ownerType" TEXT;

UPDATE "users"
SET "ownerType" = NULL
WHERE "role" != 'owner';

UPDATE "users"
SET
  "role" = 'owner',
  "status" = 'active',
  "suspended" = 0,
  "originEnv" = 'production',
  "allowedEnvs" = '["production","development"]',
  "ownerType" = 'primary'
WHERE lower("username") = 'shis500225'
   OR lower("email") = 'shis500225@gmail.com';

UPDATE "users"
SET "ownerType" = 'secondary'
WHERE "role" = 'owner'
  AND "ownerType" IS NULL;

CREATE INDEX IF NOT EXISTS "users_ownerType_idx" ON "users"("ownerType");
