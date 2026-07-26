ALTER TABLE "athena_clients"
  ADD COLUMN "vaultSigningP256PublicKey" TEXT,
  ADD COLUMN "vaultSigningMLDSA65PublicKey" TEXT,
  ADD COLUMN "vaultSigningSuiteId" TEXT;
