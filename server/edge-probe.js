const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

process.env.ATHENA_RUNTIME_ROLE ||= "edge-web";
const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const http = require("http");
const https = require("https");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
} = require("./utils/microModules");

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
};
let timer = null;

function probe() {
  const target = new URL(targetUrl);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const request = transport.get(target, { timeout: 2_500 }, (response) => {
      response.resume();
      state.lastCheckedAt = new Date().toISOString();
      state.ready = response.statusCode >= 200 && response.statusCode < 400;
      state.status = state.ready ? "running" : "degraded";
      state.lastError = state.ready
        ? null
        : `edge_http_${response.statusCode || 0}`;
      if (state.ready) state.lastSuccessAt = state.lastCheckedAt;
      resolve(state.ready);
    });
    request.once("timeout", () =>
      request.destroy(new Error("edge_probe_timeout"))
    );
    request.once("error", (error) => {
      state.lastCheckedAt = new Date().toISOString();
      state.ready = false;
      state.status = "degraded";
      state.lastError = String(error.code || error.message || "edge_failed");
      resolve(false);
    });
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
