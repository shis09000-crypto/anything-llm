const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { userFromSession } = require("../utils/http");
const { WorkspaceVisualAsset } = require("../models/workspaceVisualAsset");
const { isStableNodeKey } = require("../utils/knowledgeGraph/nodeIdentity");
const {
  invalidateWorkspaceOverviewCache,
} = require("../utils/workspaceOverview");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single("file");

function handleImageUpload(request, response, next) {
  upload(request, response, (error) => {
    if (error) {
      response.status(400).json({
        success: false,
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "image_too_large"
            : error.message || "invalid_image_upload",
      });
      return;
    }
    next();
  });
}

function parseScope(body = {}, query = {}) {
  const scopeType = body.scopeType || query.scopeType || "workspace";
  return scopeType === "node" ? "node" : "workspace";
}

function workspaceVisualAssetEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/visual-assets",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const scopeType = parseScope({}, request.query);
        const nodeKey = String(request.query.nodeKey || "").trim();
        if (scopeType === "node" && nodeKey && !isStableNodeKey(nodeKey)) {
          response
            .status(400)
            .json({ success: false, error: "invalid_node_key" });
          return;
        }
        const assets = await WorkspaceVisualAsset.list({
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          scopeType,
          nodeKey: scopeType === "node" ? nodeKey : null,
        });
        response.status(200).json({ success: true, assets });
      } catch (error) {
        console.error("[WorkspaceVisualAsset] list failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/visual-assets/upload",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
      handleImageUpload,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = request.body || {};
        const scopeType = parseScope(body);
        const nodeKey = String(body.nodeKey || "").trim();
        if (scopeType === "node" && !isStableNodeKey(nodeKey)) {
          response
            .status(400)
            .json({ success: false, error: "invalid_node_key" });
          return;
        }
        const result = await WorkspaceVisualAsset.upsertFromUpload({
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          scopeType,
          nodeKey: scopeType === "node" ? nodeKey : null,
          nodeLabel: body.nodeLabel,
          nodeType: body.nodeType,
          role: body.role || WorkspaceVisualAsset.DEFAULT_ROLE,
          file: request.file,
          uploadedBy: user?.id || null,
        });
        if (result.success) {
          invalidateWorkspaceOverviewCache({ workspaceId: workspace.id });
        }
        response.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        console.error("[WorkspaceVisualAsset] upload failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/visual-assets/:id/file",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const result = await WorkspaceVisualAsset.fileFor({
          workspaceId: workspace.id,
          id: request.params.id,
        });
        if (!result) {
          response.sendStatus(404).end();
          return;
        }
        const { asset, filePath } = result;
        const stat = fs.statSync(filePath);
        const etag = `"${asset.id}-${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
        if (request.headers["if-none-match"] === etag) {
          response.sendStatus(304).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": asset.mime || "image/webp",
          "Content-Length": stat.size,
          "Cache-Control": "private, max-age=604800",
          ETag: etag,
          "Content-Disposition": `inline; filename=${path.basename(filePath)}`,
        });
        fs.createReadStream(filePath).pipe(response);
      } catch (error) {
        console.error("[WorkspaceVisualAsset] file failed", error);
        response
          .status(500)
          .json({ success: false, error: "asset_file_failed" });
      }
    }
  );

  app.delete(
    "/workspace/:slug/visual-assets/:id",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const result = await WorkspaceVisualAsset.delete({
          workspaceId: workspace.id,
          id: request.params.id,
        });
        if (result.success) {
          invalidateWorkspaceOverviewCache({ workspaceId: workspace.id });
        }
        response.status(result.success ? 200 : 404).json(result);
      } catch (error) {
        console.error("[WorkspaceVisualAsset] delete failed", error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { workspaceVisualAssetEndpoints };
