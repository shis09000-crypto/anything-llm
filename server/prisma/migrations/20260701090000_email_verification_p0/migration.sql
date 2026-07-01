ALTER TABLE "email_verification_codes" ADD COLUMN "challenge_id" TEXT;
ALTER TABLE "email_verification_codes" ADD COLUMN "client_id" TEXT;
ALTER TABLE "email_verification_codes" ADD COLUMN "device_id" TEXT;
ALTER TABLE "email_verification_codes" ADD COLUMN "session_id" TEXT;

CREATE UNIQUE INDEX "email_verification_codes_challenge_id_key" ON "email_verification_codes"("challenge_id");
CREATE INDEX "email_verification_codes_client_id_purpose_idx" ON "email_verification_codes"("client_id", "purpose");
CREATE INDEX "email_verification_codes_device_id_purpose_idx" ON "email_verification_codes"("device_id", "purpose");
