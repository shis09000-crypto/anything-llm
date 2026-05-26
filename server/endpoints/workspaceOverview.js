const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const {
  buildWorkspaceOverview,
  recordRecommendationUsage,
} = require("../utils/workspaceOverview");

function workspaceOverviewEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/overview",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const overview = await buildWorkspaceOverview({
          workspace,
          user: response.locals.user || null,
          threadSlug: request.query.threadSlug || null,
        });
        response.status(200).json({ overview });
      } catch (error) {
        console.error("[WorkspaceOverview] overview endpoint failed:", error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/overview/recommendation-usage",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const body = reqBody(request);
        const result = await recordRecommendationUsage({
          workspaceId: workspace.id,
          userId: response.locals.user?.id || 0,
          recommendationId: body?.recommendationId,
          formulaVersion: body?.formulaVersion,
          type: body?.type,
          targetType: body?.targetType,
          targetId: body?.targetId,
          action: body?.action,
          pageSessionId: body?.pageSessionId,
        });
        if (!result.success) {
          response.status(400).json(result);
          return;
        }
        response.status(200).json(result);
      } catch (error) {
        console.error("[WorkspaceOverview] usage endpoint failed:", error);
        response.status(500).json({ error: error.message });
      }
    }
  );
}

module.exports = { workspaceOverviewEndpoints };
