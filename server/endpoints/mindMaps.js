const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { DataAccessCenter } = require("../utils/dataAccess");
const { generateMindMap, listMindMaps } = require("../utils/mindMap");
const { graphMindMapFromConcept } = require("../utils/mindMap/graph");

const WorkspaceMindMaps = DataAccessCenter.workspaceMindMap;

function mindMapEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/mind-maps",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const mindMaps = await listMindMaps({
          workspace,
          user,
          threadSlug: request.query.threadSlug || null,
        });
        response.status(200).json({ mindMaps });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/mind-maps/graph",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const concept = String(request.query.concept || "").trim();
        if (!concept) {
          response.status(400).json({ error: "concept_required" });
          return;
        }
        const result = await graphMindMapFromConcept({
          workspaceId: workspace.id,
          concept,
          maxDepth: request.query.maxDepth,
          maxExpandedNodes: request.query.maxExpandedNodes,
          confidenceCutoff: request.query.confidenceCutoff,
          layout: request.query.layout,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/mind-maps/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const mindMap = await WorkspaceMindMaps.get({
          id: Number(request.params.id),
          workspaceId: workspace.id,
          cacheUserKey: WorkspaceMindMaps.cacheUserKey(user),
        });
        if (!mindMap) {
          response.sendStatus(404).end();
          return;
        }
        response.status(200).json({ mindMap });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/mind-maps/generate",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const result = await generateMindMap({
          workspace,
          user,
          body: reqBody(request),
        });
        response.status(200).json(result);
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.patch(
    "/workspace/:slug/mind-maps/:id/viewport",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { viewport = null } = reqBody(request);
        const mindMap = await WorkspaceMindMaps.updateViewport({
          id: request.params.id,
          workspaceId: workspace.id,
          user,
          viewport,
        });
        if (!mindMap) {
          response.sendStatus(404).end();
          return;
        }
        response.status(200).json({ mindMap });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );
}

module.exports = { mindMapEndpoints };
