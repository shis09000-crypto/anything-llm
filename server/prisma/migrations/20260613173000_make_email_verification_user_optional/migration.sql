PRAGMA foreign_keys=OFF;

CREATE TABLE "new_email_verification_codes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" DATETIME,
    "request_ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_email_verification_codes" (
    "id",
    "user_id",
    "email",
    "purpose",
    "code_hash",
    "expiresAt",
    "attempts",
    "consumedAt",
    "request_ip",
    "createdAt"
)
SELECT
    "id",
    "user_id",
    "email",
    "purpose",
    "code_hash",
    "expiresAt",
    "attempts",
    "consumedAt",
    "request_ip",
    "createdAt"
FROM "email_verification_codes";

DROP TABLE "email_verification_codes";
ALTER TABLE "new_email_verification_codes" RENAME TO "email_verification_codes";

CREATE INDEX "email_verification_codes_user_id_idx" ON "email_verification_codes"("user_id");
CREATE INDEX "email_verification_codes_user_id_purpose_idx" ON "email_verification_codes"("user_id", "purpose");
CREATE INDEX "email_verification_codes_email_purpose_idx" ON "email_verification_codes"("email", "purpose");
CREATE INDEX "email_verification_codes_request_ip_createdAt_idx" ON "email_verification_codes"("request_ip", "createdAt");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
