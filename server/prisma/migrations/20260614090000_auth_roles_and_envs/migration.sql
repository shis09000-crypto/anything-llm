ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD COLUMN "allowedEnvs" TEXT NOT NULL DEFAULT '[]';

UPDATE "users"
SET
  "role" = CASE
    WHEN "suspended" = 1 THEN 'disabled'
    WHEN "role" = 'default' THEN 'user'
    WHEN "role" = 'manager' THEN 'admin'
    WHEN "role" IN ('disabled', 'user', 'developer', 'admin', 'owner') THEN "role"
    ELSE 'user'
  END,
  "status" = CASE
    WHEN "suspended" = 1 OR "role" = 'disabled' THEN 'disabled'
    ELSE 'active'
  END,
  "allowedEnvs" = CASE
    WHEN "suspended" = 1 OR "role" = 'disabled' THEN '[]'
    WHEN "role" = 'developer' THEN '["development"]'
    WHEN "role" IN ('admin', 'owner', 'manager') THEN '["production","development"]'
    ELSE '["production"]'
  END,
  "originEnv" = CASE
    WHEN "role" = 'developer' THEN 'development'
    WHEN "originEnv" IS NOT NULL THEN "originEnv"
    ELSE 'production'
  END;

CREATE INDEX IF NOT EXISTS "users_role_idx" ON "users"("role");
CREATE INDEX IF NOT EXISTS "users_status_idx" ON "users"("status");
