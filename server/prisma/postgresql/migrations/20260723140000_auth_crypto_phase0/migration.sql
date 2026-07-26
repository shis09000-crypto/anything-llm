ALTER TABLE "users" ADD COLUMN "credentialType" TEXT NOT NULL DEFAULT 'password';

UPDATE "users"
SET "credentialType" = CASE
  WHEN "password" LIKE '$argon2id$%' THEN 'password'
  WHEN "password" LIKE '$2a$%'
    OR "password" LIKE '$2b$%'
    OR "password" LIKE '$2y$%' THEN 'password'
  ELSE 'legacy_unknown'
END;

UPDATE "users"
SET "password" = '!athena-disabled-credential:v1!'
WHERE "credentialType" = 'legacy_unknown';

CREATE INDEX "users_credentialType_idx" ON "users"("credentialType");
