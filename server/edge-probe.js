const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

process.env.ATHENA_RUNTIME_ROLE ||= "edge-web";
const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
} = require("./utils/microModules");
const { probeEdgeRoutes } = require("./utils/microModules/edgeRouteProbes");

const role = "edge-web";
const port = Number(process.env.EDGE_PROBE_PORT || 3025);
const targetUrl = String(
  process.env.ATHENA_EDGE_LOCAL_HEALTH_URL ||
    "http://anything-llm-web:3000/health"
).trim();
const state = {
  ready: false,
  status: "starting",
  target: new URL(targetUrl).origin,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastError: null,
  probes: {},
};
let timer = null;

function probe() {
  return probeEdgeRoutes({
    origin: new URL(targetUrl).origin,
    healthUrl: targetUrl,
  }).then((result) => {
    state.lastCheckedAt = new Date().toISOString();
    state.ready = result.ready;
    state.probes = result.probes;
    state.status = state.ready ? "running" : "degraded";
    state.lastError = state.ready
      ? null
      : Object.values(result.probes).find((entry) => !entry.ready)
          ?.reasonCode || "edge_route_probe_failed";
    if (state.ready) state.lastSuccessAt = state.lastCheckedAt;
    return state.ready;
  });
}

function schedule() {
  if (timer) return;
  timer = setInterval(() => void probe(), 5_000);
  timer.unref?.();
}

const host = new MicroModuleServiceHost({
  manifestId: "edge-web",
  role,
  port,
  readiness: () => ({ ...state }),
  onStart: async () => {
    await probe();
    schedule();
  },
  onStop: async () => {
    if (timer) clearInterval(timer);
    timer = null;
  },
});

installStandaloneShutdown(host, { name: "EdgeProbe" });
host
  .start()
  .then((snapshot) =>
    console.log(`[EdgeProbe] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[EdgeProbe] failed to start", error);
    process.exitCode = 1;
  });
