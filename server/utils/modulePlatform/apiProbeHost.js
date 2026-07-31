const { MicroModuleServiceHost } = require("../microModules");
const { publicReadinessSnapshot } = require("../runtimeReadiness");
const { moduleReadinessEnvelope } = require("./readiness");

const COLOCATED_MODULES = new Set(["athena-api"]);

function componentSnapshot(moduleId) {
  const publicState = publicReadinessSnapshot();
  if (moduleId === "athena-api") return publicState;
  return { ready: false, status: "not-ready", reasonCode: "module_unknown" };
}

function colocatedModuleReadiness(moduleId) {
  if (!COLOCATED_MODULES.has(moduleId)) return null;
  return moduleReadinessEnvelope(moduleId, componentSnapshot(moduleId), {
    source: "api-control",
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
