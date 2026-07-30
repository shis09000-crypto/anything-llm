let provider = null;
let started = false;

function otelEnabled(env = process.env) {
  return (
    String(env.ATHENA_OTEL_ENABLED || "false").toLowerCase() === "true" ||
    Boolean(
      env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
        env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    )
  );
}

function startOpenTelemetry() {
  const {
    operationsEventForwarder,
  } = require("../operations/remoteEventForwarder");
  const forwarding = operationsEventForwarder.start();
  if (started || !otelEnabled())
    return {
      enabled: otelEnabled(),
      started,
      operationsForwarding: forwarding,
    };
  const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
  const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
  const {
    OTLPTraceExporter,
  } = require("@opentelemetry/exporter-trace-otlp-http");
  const { Resource } = require("@opentelemetry/resources");
  const resource = new Resource({
    "service.name": process.env.OTEL_SERVICE_NAME || "athena-server",
    "service.instance.id": `${require("os").hostname()}:${process.pid}`,
    "service.version": require("../../package.json").version,
    "athena.runtime.role": process.env.ATHENA_RUNTIME_ROLE || "api",
  });
  provider = new NodeTracerProvider({ resource });
  provider.addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || undefined,
      })
    )
  );
  provider.register();
  started = true;
  return {
    enabled: true,
    started: true,
    operationsForwarding: forwarding,
  };
}

async function shutdownOpenTelemetry() {
  const { flushSemanticEvents } = require("./semanticEvents");
  const {
    operationsEventForwarder,
  } = require("../operations/remoteEventForwarder");
  await operationsEventForwarder.stop();
  await flushSemanticEvents();
  if (!provider) return { stopped: true, skipped: true };
  await provider.shutdown();
  provider = null;
  started = false;
  return { stopped: true, skipped: false };
}

module.exports = {
  otelEnabled,
  shutdownOpenTelemetry,
  startOpenTelemetry,
};
