const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { userFromSession } = require("../utils/http");
const {
  confirmRepair,
  getRun,
  previewRepair,
  runSystemPatrol,
  status,
} = require("../utils/systemPatrol");

function systemPatrolEndpoints(app) {
  app.get(
    "/system/patrol/status",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        return response.status(200).json(await status());
      } catch (error) {
        console.error("[SystemPatrol] status", error.message, error);
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/system/patrol/run",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const mode = request.body?.mode === "deep" ? "deep" : "light";
        const report = await runSystemPatrol({
          mode,
          trigger: "manual",
          triggeredBy: user?.id || null,
        });
        return response.status(200).json({ success: true, run: report });
      } catch (error) {
        console.error("[SystemPatrol] run", error.message, error);
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/system/patrol/runs/:runId",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const run = await getRun(request.params.runId);
        if (!run)
          return response
            .status(404)
            .json({ success: false, error: "Patrol run not found." });
        return response.status(200).json({ success: true, run });
      } catch (error) {
        console.error("[SystemPatrol] run detail", error.message, error);
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/system/patrol/repairs/:repairId/preview",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        return response
          .status(200)
          .json(await previewRepair(request.params.repairId));
      } catch (error) {
        console.error("[SystemPatrol] repair preview", error.message, error);
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/system/patrol/repairs/:repairId/confirm",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        return response.status(200).json(
          await confirmRepair(request.params.repairId, {
            confirmedBy: user?.id || null,
          })
        );
      } catch (error) {
        console.error("[SystemPatrol] repair confirm", error.message, error);
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { systemPatrolEndpoints };
