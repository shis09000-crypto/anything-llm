const fs = require("fs");

const DEFAULT_MIGRATION_RESERVE_BYTES = 512 * 1024 * 1024;

function availableBytesForPath(targetPath) {
  const stats = fs.statfsSync(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function migrationCapacity({
  databaseBytes,
  availableBytes,
  existingBackup = false,
  reserveBytes = DEFAULT_MIGRATION_RESERVE_BYTES,
} = {}) {
  const database = Math.max(0, Number(databaseBytes || 0));
  const available = Math.max(0, Number(availableBytes || 0));
  const reserve = Math.max(0, Number(reserveBytes || 0));
  const backupBytes = existingBackup ? 0 : database;
  const databaseRewriteBytes = database;
  const requiredFreeBytes = backupBytes + databaseRewriteBytes + reserve;
  return {
    databaseBytes: database,
    availableFreeBytes: available,
    requiredFreeBytes,
    reserveBytes: reserve,
    includesNewBackup: !existingBackup,
    executeReady: available >= requiredFreeBytes,
  };
}

function inspectMigrationCapacity({
  databasePath,
  storageRoot,
  existingBackup = false,
} = {}) {
  return migrationCapacity({
    databaseBytes: fs.statSync(databasePath).size,
    availableBytes: availableBytesForPath(storageRoot),
    existingBackup,
  });
}

function assertMigrationCapacity(options = {}) {
  const capacity = inspectMigrationCapacity(options);
  if (capacity.executeReady) return capacity;
  const error = new Error("chat_content_migration_insufficient_disk_space");
  error.code = "chat_content_migration_insufficient_disk_space";
  error.capacity = capacity;
  throw error;
}

module.exports = {
  DEFAULT_MIGRATION_RESERVE_BYTES,
  assertMigrationCapacity,
  inspectMigrationCapacity,
  migrationCapacity,
};
