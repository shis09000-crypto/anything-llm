function operationsServiceReady({ plane }) {
  // operationsPlane.health().ready already represents the durable telemetry
  // path (NATS + ClickHouse). External providers and observed modules remain
  // visible in the detailed health document, but are not dependencies of the
  // observer's ingest/read API.
  return Boolean(plane?.ready);
}

module.exports = { operationsServiceReady };
