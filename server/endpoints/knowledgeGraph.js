const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { relatedConcepts, repairWorkspace } = require("../utils/knowledgeGraph");
const { KnowledgeGraph } = require("../models/knowledgeGraph");

function knowledgeGraphEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/knowledge/related",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const concept = String(request.query.concept || "").trim();
        if (!concept) {
          response.status(400).json({ error: "concept_required" });
          return;
        }

        const result = await relatedConcepts({
          workspaceId: workspace.id,
          concept,
          options: {
            maxDepth: request.query.maxDepth,
            maxExpandedNodes: request.query.maxExpandedNodes,
            confidenceCutoff: request.query.confidenceCutoff,
            includeEvidence:
              request.query.includeEvidence === "true" ||
              request.query.includeEvidence === true,
          },
        });
        response.status(200).json(result);
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/knowledge/stats",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_request, response) => {
      try {
        const workspace = response.locals.workspace;
        const stats = await KnowledgeGraph.graphStats(workspace.id);
        response.status(200).json({ stats });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/knowledge/repair-status",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_request, response) => {
      try {
        const workspace = response.locals.workspace;
        const repair = await KnowledgeGraph.repairStatus(workspace.id);
        response.status(200).json({ repair });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/knowledge/repair",
    [validatedRequest, flexUserRoleValid([ROLES.admin]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const result = await repairWorkspace({
          workspace,
          trigger: "api",
          allowReembed: request.body?.allowReembed === true,
          force: request.body?.force === true,
          batchSize: request.body?.batchSize,
          scanLimit: request.body?.scanLimit || 100,
        });
        response.status(200).json({ result });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/knowledge/repair/quarantine/:issueId/release",
    [validatedRequest, flexUserRoleValid([ROLES.admin]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const issue = await KnowledgeGraph.releaseQuarantineIssue({
          workspaceId: workspace.id,
          issueId: request.params.issueId,
        });
        if (!issue) {
          response.status(404).json({ error: "quarantine_issue_not_found" });
          return;
        }
        response.status(200).json({ issue });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/knowledge/concepts",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const concepts = await KnowledgeGraph.searchConcepts({
          workspaceId: workspace.id,
          query: request.query.q || "",
          limit: request.query.limit || 10,
        });
        response.status(200).json({ concepts });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );
}

module.exports = { knowledgeGraphEndpoints };
