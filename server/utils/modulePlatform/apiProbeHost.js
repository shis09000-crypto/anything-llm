const { MicroModuleServiceHost } = require("../microModules");
const {
  detailedReadinessSnapshot,
  publicReadinessSnapshot,
} = require("../runtimeReadiness");
const { moduleReadinessEnvelope } = require("./readiness");

const COLOCATED_MODULES = new Set([
  "athena-api",
  "authentication",
  "knowledge-ingest",
  "rag",
]);

function componentSnapshot(moduleId) {
  const publicState = publicReadinessSnapshot();
  if (moduleId === "athena-api") return publicState;
  const detail = detailedReadinessSnapshot();
  if (moduleId === "authentication")
    return {
      ready: publicState.ready,
      status: publicState.status,
      reasonCode: publicState.reasonCode,
      keyCustody: {
        status: detail.controlPlane?.keyCustody?.status || "unknown",
        quarantined: Boolean(detail.controlPlane?.keyCustody?.quarantined),
        writeBarrier: Boolean(detail.controlPlane?.keyCustody?.writeBarrier),
      },
      authSessions: {
        running: Boolean(detail.controlPlane?.authSessions?.running),
        healthy: Boolean(detail.controlPlane?.authSessions?.healthy),
      },
    };
  if (moduleId === "knowledge-ingest")
    return {
      ready: publicState.ready,
      status: publicState.status,
      reasonCode: publicState.reasonCode,
      deploymentMode: "co-located-control",
      downstreamOwnership: ["collector", "reader-worker", "rag"],
    };
  if (moduleId === "rag")
    return {
      ready: publicState.ready,
      status: publicState.status,
      reasonCode: publicState.reasonCode,
      deploymentMode: "co-located-control",
    };
  return { ready: false, status: "not-ready", reasonCode: "module_unknown" };
}

function colocatedModuleReadiness(moduleId) {
  if (!COLOCATED_MODULES.has(moduleId)) return null;
  return moduleReadinessEnvelope(moduleId, componentSnapshot(moduleId), {
    source: moduleId === "athena-api" ? "api-control" : "co-located-probe",
  });
}

function createApiProbeHost({
  port = Number(process.env.ATHENA_API_INTERNAL_PORT || 3024),
} = {}) {
  return new MicroModuleServiceHost({
    manifestId: "athena-api",
    role: "api",
    port,
    readiness: () => componentSnapshot("athena-api"),
    registerRoutes: (app) => {
      app.get(
        "/internal/v1/module-readiness/:moduleId",
        (request, response) => {
          const snapshot = colocatedModuleReadiness(request.params.moduleId);
          if (!snapshot)
            return response.status(404).json({
              success: false,
              error: "module_readiness_provider_not_found",
            });
          return response.status(snapshot.ready ? 200 : 503).json({
            success: snapshot.ready,
            ...snapshot,
          });
        }
      );
    },
  });
}

module.exports = {
  COLOCATED_MODULES,
  colocatedModuleReadiness,
  componentSnapshot,
  createApiProbeHost,
};
