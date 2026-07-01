CREATE TABLE "vault_items" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "itemId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "itemType" TEXT NOT NULL DEFAULT 'secret',
  "label" TEXT,
  "keyId" TEXT NOT NULL,
  "cryptoVersion" TEXT NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" DATETIME,
  CONSTRAINT "vault_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "vault_items_userId_itemId_key" ON "vault_items"("userId", "itemId");
CREATE INDEX "vault_items_userId_deletedAt_idx" ON "vault_items"("userId", "deletedAt");
CREATE INDEX "vault_items_userId_itemType_idx" ON "vault_items"("userId", "itemType");
CREATE INDEX "vault_items_updatedAt_idx" ON "vault_items"("updatedAt");
