const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const {
  healthBeacon,
  refreshHealthBeacon,
  unknownBeacon,
} = require("../utils/workspaceHealth/beacon");

function userRefreshKey(request, response) {
  return response.locals.user?.id || request.ip || "single-user";
}

function workspaceHealthEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/health/beacon",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_request, response) => {
      const workspace = response.locals.workspace;
      try {
        const beacon = await healthBeacon({
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
        });
        response.status(200).json({ beacon });
      } catch (error) {
        console.error("[WorkspaceHealth] beacon endpoint failed:", error);
        response.status(200).json({
          beacon: unknownBeacon(workspace.slug),
        });
      }
    }
  );

  app.post(
    "/workspace/:slug/health/refresh",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      const workspace = response.locals.workspace;
      try {
        const beacon = await refreshHealthBeacon({
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userKey: userRefreshKey(request, response),
        });
        response.status(200).json({ beacon });
      } catch (error) {
        console.error("[WorkspaceHealth] refresh endpoint failed:", error);
        response.status(200).json({
          beacon: {
            ...unknownBeacon(workspace.slug),
            cooldownRemainingMs: 0,
            refreshed: false,
          },
        });
      }
    }
  );
}

module.exports = { workspaceHealthEndpoints };
