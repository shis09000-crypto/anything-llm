const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { detailedReadinessSnapshot } = require("../utils/runtimeReadiness");

function runtimeDiagnosticsEndpoints(app) {
  if (!app) return;
  app.get(
    "/system/runtime-diagnostics",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    (_request, response) => {
      const snapshot = detailedReadinessSnapshot();
      response.setHeader("Cache-Control", "no-store");
      return response.status(snapshot.ready ? 200 : 503).json({
        success: snapshot.ready,
        diagnostics: snapshot,
      });
    }
  );
}

module.exports = { runtimeDiagnosticsEndpoints };
