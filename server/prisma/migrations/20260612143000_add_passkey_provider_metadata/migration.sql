ALTER TABLE "PasskeyCredential" ADD COLUMN "browserName" TEXT;
ALTER TABLE "PasskeyCredential" ADD COLUMN "platformName" TEXT;
ALTER TABLE "PasskeyCredential" ADD COLUMN "aaguid" TEXT;
ALTER TABLE "PasskeyCredential" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "PasskeyCredential" ADD COLUMN "providerName" TEXT NOT NULL DEFAULT '来源待确认';
ALTER TABLE "PasskeyCredential" ADD COLUMN "backedUp" BOOLEAN;
