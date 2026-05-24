const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const {
  relatedConcepts,
  reasoningPaths,
  repairWorkspace,
  nodeMetricsResponse,
  requestNodeMetricsRecompute,
} = require("../utils/knowledgeGraph");
const {
  nodeEvidence,
  edgeEvidence,
} = require("../utils/knowledgeGraph/evidence");
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
    "/workspace/:slug/knowledge/path",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const source = String(request.query.source || "").trim();
        const target = String(request.query.target || "").trim();
        if (!source || !target) {
          response.status(400).json({ error: "source_and_target_required" });
          return;
        }
        const result = await reasoningPaths({
          workspaceId: workspace.id,
          source,
          target,
          options: {
            maxDepth: request.query.maxDepth,
            limit: request.query.limit,
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

  app.get(
    "/workspace/:slug/knowledge/evidence/node",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const nodeId = request.query.nodeId || request.query.id || null;
        const concept = String(request.query.concept || "").trim();
        if (!nodeId && !concept) {
          response.status(400).json({ error: "node_or_concept_required" });
          return;
        }
        const evidence = await nodeEvidence({
          workspaceId: workspace.id,
          nodeId,
          concept,
          page: request.query.page,
          limit: request.query.limit,
          sort: request.query.sort,
          cluster: request.query.cluster,
        });
        if (!evidence) {
          response.status(404).json({ error: "concept_not_found" });
          return;
        }
        response.status(200).json({ evidence });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/knowledge/evidence/edge",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const edgeId = request.query.edgeId || request.query.id;
        if (!edgeId) {
          response.status(400).json({ error: "edge_required" });
          return;
        }
        const evidence = await edgeEvidence({
          workspaceId: workspace.id,
          edgeId,
          page: request.query.page,
          limit: request.query.limit,
          sort: request.query.sort,
          cluster: request.query.cluster,
        });
        if (!evidence) {
          response.status(404).json({ error: "edge_not_found" });
          return;
        }
        response.status(200).json({ evidence });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/knowledge/evidence/usage",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const usage = await KnowledgeGraph.recordEvidenceUsage({
          workspaceId: workspace.id,
          targetType: request.body?.targetType,
          targetId: request.body?.targetId,
          action: request.body?.action,
        });
        if (!usage) {
          response.status(400).json({ error: "invalid_evidence_usage" });
          return;
        }
        response.status(200).json({ usage });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/knowledge/node-metrics",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const nodeId = request.query.nodeId || request.query.id || null;
        const concept = String(request.query.concept || "").trim();
        if (!nodeId && !concept) {
          response.status(400).json({ error: "node_or_concept_required" });
          return;
        }
        const metrics = await nodeMetricsResponse({
          workspaceId: workspace.id,
          nodeId,
          concept,
        });
        response.status(200).json({ metrics });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/knowledge/node-metrics/recompute",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const result = await requestNodeMetricsRecompute({
          workspaceId: workspace.id,
          nodeId: request.body?.nodeId || request.query.nodeId || null,
          concept: request.body?.concept || request.query.concept || "",
        });
        response.status(result.queued ? 200 : 404).json({ result });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: error.message });
      }
    }
  );
}

module.exports = { knowledgeGraphEndpoints };
