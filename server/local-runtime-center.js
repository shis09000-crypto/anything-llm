const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "local-runtime-center";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { localRuntimeCenter } = require("./utils/localRuntime/runtime");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");

const host = new MicroModuleServiceHost({
  manifestId: "local-runtime-center",
  role: "local-runtime-center",
  port: Number(process.env.LOCAL_RUNTIME_CENTER_PORT || 3036),
  jsonLimit: "1mb",
  enableWebSockets: true,
  readiness: () => localRuntimeCenter.snapshot(),
  onStart: async () => {
    await secureDatabaseStart("local-runtime-center");
    localRuntimeCenter.start();
  },
  onDrain: async () => localRuntimeCenter.drain(),
  registerRoutes: (app) => {
    app.post(
      "/internal/v1/local-runtime/dispatch",
      async (request, response) => {
        const operation = String(request.body?.operation || "");
        const input = request.body?.input || {};
        const handlers = {
          dispatch: (payload) => localRuntimeCenter.dispatch(payload),
          cancel: (payload) => localRuntimeCenter.cancel(payload),
          status: () => localRuntimeCenter.snapshot(),
          issuePairingTicket: (payload) =>
            localRuntimeCenter.issuePairingTicket(payload),
          listDevices: (payload) =>
            localRuntimeCenter.listDevices(payload.ownerUserId),
          revokeDevice: (payload) =>
            localRuntimeCenter.revokeDevice(
              payload.ownerUserId,
              payload.deviceId
            ),
          createLease: (payload) => localRuntimeCenter.createLease(payload),
          listLeases: (payload) =>
            localRuntimeCenter.listLeases(
              payload.ownerUserId,
              payload.deviceId || null
            ),
          revokeLease: (payload) =>
            localRuntimeCenter.revokeLease(
              payload.ownerUserId,
              payload.leaseId
            ),
          listJobs: (payload) =>
            localRuntimeCenter.listJobs(
              payload.ownerUserId,
              payload.deviceId || null
            ),
          jobEvents: (payload) =>
            localRuntimeCenter.jobEvents(
              payload.ownerUserId,
              payload.jobId,
              payload.afterSequence
            ),
        };
        const handler = handlers[operation];
        if (!handler)
          return response
            .status(400)
            .json({ success: false, error: "local_runtime_operation_unknown" });
        response.json({ success: true, result: await handler(input) });
      }
    );
    app.ws("/api/local-runtime/device/connect", (socket) => {
      if (process.env.ATHENA_LOCAL_RUNTIME_ENABLED !== "true")
        return socket.close(4005, "local_runtime_disabled");
      void localRuntimeCenter.handleDeviceSocket(socket);
    });
  },
});

installStandaloneShutdown(host, { name: "LocalRuntimeCenter" });
host
  .start()
  .then(() => {
    console.log(`[LocalRuntimeCenter] listening on ${host.port}`);
  })
  .catch((error) => {
    console.error("[LocalRuntimeCenter] failed to start", error);
    process.exitCode = 1;
  });
