CREATE TABLE "crypto_forecast_store_snapshots" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "snapshot_sha256" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "bytes" BIGINT NOT NULL,
  "summary_json" TEXT NOT NULL,
  "producer_instance" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "crypto_forecast_store_snapshots_snapshot_sha256_key"
  ON "crypto_forecast_store_snapshots"("snapshot_sha256");
CREATE INDEX "crypto_forecast_store_snapshots_created_at_idx"
  ON "crypto_forecast_store_snapshots"("created_at");
