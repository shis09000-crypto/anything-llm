const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { handleFileUpload } = require("../utils/files/multer");
const { NodeSupplement } = require("../models/nodeSupplement");
const {
  ingestUploadedSupplementFile,
  ingestTextSupplement,
} = require("../utils/knowledgeGraph/supplementIngestor");
const { isStableNodeKey } = require("../utils/knowledgeGraph/nodeIdentity");
const {
  resolveNodeIdentity,
} = require("../utils/knowledgeGraph/nodeIdentityResolver");

function nodeMetadata(body = {}) {
  return {
    supplementScope: "node",
    nodeKey: body?.nodeKey,
    nodeId: body?.nodeId || null,
    canonicalKey: body?.canonicalKey || null,
    nodeLabel: body?.nodeLabel || "",
    nodeType: body?.nodeType || "concept",
    createdAt: new Date().toISOString(),
  };
}

async function resolveNodeRequestBody(workspaceId, body = {}) {
  if (body?.nodeKey && !isStableNodeKey(body.nodeKey))
    return { success: false, error: "invalid_node_key" };
  const result = await resolveNodeIdentity({
    workspaceId,
    nodeId: body?.nodeId,
    nodeKey: body?.nodeKey,
    canonicalKey: body?.canonicalKey,
    label: body?.nodeLabel,
  });
  if (!result.success)
    return {
      success: false,
      error: result.reason || "node_not_found",
      candidates: result.candidates || [],
    };
  return { success: true, node: result.node };
}

function nodeSupplementEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/node-supplements",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const nodeKey = String(request.query.nodeKey || "").trim();
        if (!nodeKey) {
          response
            .status(400)
            .json({ success: false, error: "nodeKey_required" });
          return;
        }
        const supplements = await NodeSupplement.list({
          workspaceId: workspace.id,
          nodeKey,
        });
        response.status(200).json({ success: true, supplements });
      } catch (error) {
        console.error("[NodeSupplement] list failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/node-supplements",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const body = reqBody(request);
        const result = await NodeSupplement.upsert({
          workspaceId: workspace.id,
          nodeId: body?.nodeId || null,
          nodeKey: body?.nodeKey,
          canonicalKey: body?.canonicalKey || null,
          nodeLabel: body?.nodeLabel,
          nodeType: body?.nodeType,
          documentId: body?.documentId,
          priority: body?.priority || 0,
          metadata: body?.metadata || {},
        });
        if (!result.success) {
          response.status(400).json(result);
          return;
        }
        response.status(200).json(result);
      } catch (error) {
        console.error("[NodeSupplement] create failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/node-supplements/upload",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = request.body || {};
        const resolved = await resolveNodeRequestBody(workspace.id, body);
        if (!resolved.success) {
          response.status(400).json(resolved);
          return;
        }
        body.nodeKey = resolved.node.nodeKey;
        body.nodeId = resolved.node.nodeId;
        body.canonicalKey = resolved.node.canonicalKey;
        body.nodeLabel = body.nodeLabel || resolved.node.nodeLabel;
        body.nodeType = body.nodeType || resolved.node.nodeType;
        const metadata = {
          ...nodeMetadata(body),
          source: "node_supplement_upload",
          identitySource: resolved.node.identitySource,
        };
        const ingest = await ingestUploadedSupplementFile({
          workspace,
          file: request.file,
          userId: user?.id || null,
          metadata,
        });
        if (!ingest.success) {
          response.status(400).json(ingest);
          return;
        }
        const result = await NodeSupplement.upsert({
          workspaceId: workspace.id,
          nodeId: body?.nodeId || null,
          nodeKey: body?.nodeKey,
          canonicalKey: body?.canonicalKey || null,
          nodeLabel: body?.nodeLabel,
          nodeType: body?.nodeType,
          documentId: ingest.document.docId,
          priority: body?.priority || 0,
          metadata,
        });
        response.status(result.success ? 200 : 400).json({
          ...result,
          document: ingest.document,
        });
      } catch (error) {
        console.error("[NodeSupplement] upload failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/node-supplements/text",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const resolved = await resolveNodeRequestBody(workspace.id, body);
        if (!resolved.success) {
          response.status(400).json(resolved);
          return;
        }
        body.nodeKey = resolved.node.nodeKey;
        body.nodeId = resolved.node.nodeId;
        body.canonicalKey = resolved.node.canonicalKey;
        body.nodeLabel = body.nodeLabel || resolved.node.nodeLabel;
        body.nodeType = body.nodeType || resolved.node.nodeType;
        const metadata = {
          ...nodeMetadata(body),
          source: "node_supplement_text",
          identitySource: resolved.node.identitySource,
        };
        const ingest = await ingestTextSupplement({
          workspace,
          title:
            body?.title || `节点补充 - ${body?.nodeLabel || body?.nodeKey}`,
          text: body?.text,
          userId: user?.id || null,
          metadata,
        });
        if (!ingest.success) {
          response.status(400).json(ingest);
          return;
        }
        const result = await NodeSupplement.upsert({
          workspaceId: workspace.id,
          nodeId: body?.nodeId || null,
          nodeKey: body?.nodeKey,
          canonicalKey: body?.canonicalKey || null,
          nodeLabel: body?.nodeLabel,
          nodeType: body?.nodeType,
          documentId: ingest.document.docId,
          priority: body?.priority || 0,
          metadata: ingest.metadata || metadata,
        });
        response.status(result.success ? 200 : 400).json({
          ...result,
          document: ingest.document,
        });
      } catch (error) {
        console.error("[NodeSupplement] text failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.delete(
    "/workspace/:slug/node-supplements/:id",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const result = await NodeSupplement.delete({
          workspaceId: workspace.id,
          id: request.params.id,
        });
        response.status(result.success ? 200 : 404).json(result);
      } catch (error) {
        console.error("[NodeSupplement] delete failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { nodeSupplementEndpoints };
