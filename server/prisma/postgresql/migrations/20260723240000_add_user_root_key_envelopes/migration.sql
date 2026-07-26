CREATE TABLE "user_root_key_epochs" (
    "id" TEXT NOT NULL,
    "authUserId" INTEGER NOT NULL,
    "rootEpoch" INTEGER NOT NULL,
    "rootKeyId" TEXT NOT NULL,
    "derivationSuiteId" TEXT NOT NULL,
    "transportSuiteId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "initializedByClientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "user_root_key_epochs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_root_key_envelopes" (
    "id" TEXT NOT NULL,
    "authUserId" INTEGER NOT NULL,
    "sourceClientId" TEXT NOT NULL,
    "targetClientId" TEXT NOT NULL,
    "sourceKeyGeneration" INTEGER NOT NULL DEFAULT 1,
    "targetKeyGeneration" INTEGER NOT NULL DEFAULT 1,
    "rootEpoch" INTEGER NOT NULL,
    "rootKeyId" TEXT NOT NULL,
    "derivationSuiteId" TEXT NOT NULL,
    "transportSuiteId" TEXT NOT NULL,
    "envelopeVersion" TEXT NOT NULL,
    "envelopeJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "user_root_key_envelopes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_root_key_challenges" (
    "id" TEXT NOT NULL,
    "authUserId" INTEGER NOT NULL,
    "sourceClientId" TEXT NOT NULL,
    "targetClientId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "user_root_key_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_root_key_epochs_authUserId_rootEpoch_key"
ON "user_root_key_epochs"("authUserId", "rootEpoch");
CREATE INDEX "user_root_key_epochs_authUserId_status_rootEpoch_idx"
ON "user_root_key_epochs"("authUserId", "status", "rootEpoch");
CREATE INDEX "user_root_key_epochs_rootKeyId_idx"
ON "user_root_key_epochs"("rootKeyId");

CREATE UNIQUE INDEX "user_root_key_envelopes_authUserId_targetClientId_targetKeyGeneration_rootEpoch_key"
ON "user_root_key_envelopes"("authUserId", "targetClientId", "targetKeyGeneration", "rootEpoch");
CREATE INDEX "user_root_key_envelopes_authUserId_targetClientId_consumedAt_expiresAt_idx"
ON "user_root_key_envelopes"("authUserId", "targetClientId", "consumedAt", "expiresAt");
CREATE INDEX "user_root_key_envelopes_authUserId_rootEpoch_rootKeyId_idx"
ON "user_root_key_envelopes"("authUserId", "rootEpoch", "rootKeyId");

CREATE INDEX "user_root_key_challenges_authUserId_sourceClientId_targetClientId_purpose_consumedAt_idx"
ON "user_root_key_challenges"("authUserId", "sourceClientId", "targetClientId", "purpose", "consumedAt");
CREATE INDEX "user_root_key_challenges_expiresAt_idx"
ON "user_root_key_challenges"("expiresAt");

ALTER TABLE "user_root_key_epochs"
ADD CONSTRAINT "user_root_key_epochs_authUserId_fkey"
FOREIGN KEY ("authUserId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_root_key_envelopes"
ADD CONSTRAINT "user_root_key_envelopes_authUserId_fkey"
FOREIGN KEY ("authUserId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_root_key_challenges"
ADD CONSTRAINT "user_root_key_challenges_authUserId_fkey"
FOREIGN KEY ("authUserId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
