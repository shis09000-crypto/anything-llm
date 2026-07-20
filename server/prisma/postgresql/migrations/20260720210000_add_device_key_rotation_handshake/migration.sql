ALTER TABLE "athena_clients" ADD COLUMN "pendingPublicKey" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pendingDeviceKeyAlgorithm" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pendingDeviceKeyExpiresAt" TIMESTAMP(3);
