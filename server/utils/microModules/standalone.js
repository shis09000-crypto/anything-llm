const { bootstrapSecurityContext } = require("../security/keyLifecycle");
const { shutdownOpenTelemetry } = require("../observability");

async function secureDatabaseStart(role, onStart = async () => {}) {
  const {
    remoteCustodyStatus,
    remoteKeyCustodyEnabled,
  } = require("../security/keyCustody/remoteClient");
  if (remoteKeyCustodyEnabled(process.env)) {
    await remoteCustodyStatus(process.env);
  } else {
    const security = await bootstrapSecurityContext({ runtimeRole: role });
    if (security.quarantined) {
      const error = new Error(security.reason || "key_custody_quarantined");
      error.code = "KEY_CUSTODY_QUARANTINED";
      throw error;
    }
  }
  const { DataAccessCenter } = require("../dataAccess");
  await DataAccessCenter.runtimeLifecycle.databaseReadiness();
  await onStart();
}

function installStandaloneShutdown(
  host,
  { name, beforeStop = async () => {} } = {}
) {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${name}] ${signal} received; draining.`);
    try {
      await beforeStop();
      await host.stop();
      await shutdownOpenTelemetry();
      process.exit(0);
    } catch (error) {
      console.error(`[${name}] drain failed`, error);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}

module.exports = {
  installStandaloneShutdown,
  secureDatabaseStart,
};
