ALTER TABLE "PasskeyCredential" ADD COLUMN "algorithm" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "PasskeyCredential" ADD COLUMN "parameterSet" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "PasskeyCredential" ADD COLUMN "keyOrigin" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "PasskeyCredential" ADD COLUMN "hardwareProtection" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "athena_clients" ADD COLUMN "publicKeyAlgorithm" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "publicKeyParameterSet" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "publicKeyOrigin" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "publicKeyHardwareProtection" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pendingPublicKeyParameterSet" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pendingPublicKeyOrigin" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pendingPublicKeyHardwareProtection" TEXT;

ALTER TABLE "security_key_registry" ADD COLUMN "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM';
ALTER TABLE "security_key_registry" ADD COLUMN "parameterSet" TEXT NOT NULL DEFAULT 'AES-256/GCM-96';
ALTER TABLE "security_key_registry" ADD COLUMN "keyOrigin" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "security_key_registry" ADD COLUMN "hardwareProtection" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "security_audit_checkpoints" ADD COLUMN "signatureEnvelopeJson" TEXT;
ALTER TABLE "security_audit_checkpoints" ADD COLUMN "parameterSet" TEXT NOT NULL DEFAULT 'Ed25519';
ALTER TABLE "security_audit_checkpoints" ADD COLUMN "keyOrigin" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "security_audit_checkpoints" ADD COLUMN "hardwareProtection" TEXT NOT NULL DEFAULT 'unknown';

UPDATE "security_audit_checkpoints"
SET
  "parameterSet" = CASE
    WHEN lower("algorithm") LIKE '%ed25519%' THEN 'Ed25519'
    ELSE 'unknown'
  END,
  "keyOrigin" = 'legacy-checkpoint-embedded-public-key',
  "hardwareProtection" = 'not-attested';

UPDATE "athena_clients"
SET
  "publicKeyAlgorithm" = 'ECDSA-P256-SHA256',
  "publicKeyParameterSet" = 'secp256r1',
  "publicKeyOrigin" = CASE
    WHEN "deviceFingerprintVersion" = 'p256-secure-enclave-v1' THEN 'apple-secure-enclave'
    WHEN "deviceFingerprintVersion" = 'p256-software-v1' THEN 'software-nonextractable'
    WHEN "deviceFingerprintVersion" = 'p256-v1' THEN 'webcrypto-nonextractable'
    ELSE 'unknown'
  END,
  "publicKeyHardwareProtection" = CASE
    WHEN "deviceFingerprintVersion" = 'p256-secure-enclave-v1' THEN 'client-asserted-hardware-backed'
    ELSE 'not-attested'
  END
WHERE "publicKey" IS NOT NULL;

UPDATE "security_key_registry"
SET
  "keyOrigin" = "providerType",
  "hardwareProtection" = CASE
    WHEN lower("providerType") LIKE '%kms%'
      OR lower("providerType") LIKE '%vault%'
      OR lower("providerType") LIKE '%hsm%'
      OR lower("providerType") LIKE '%keychain%'
      THEN 'provider-asserted-hardware-backed'
    WHEN lower("providerType") LIKE '%file%'
      OR lower("providerType") LIKE '%env%'
      THEN 'software-protected'
    ELSE 'unknown'
  END;
