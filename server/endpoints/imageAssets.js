const { DataAccessCenter } = require("../utils/dataAccess");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  assetForOwner,
  deleteImageAsset,
  listImageAssets,
  patchImageAsset,
  previewObjectForAsset,
  publicAsset,
  syncImageAsset,
} = require("../utils/imageAssets/service");

const guards = [validatedRequest, flexUserRoleValid([ROLES.all])];

function statusFor(error) {
  if (String(error?.code || "").includes("not_found")) return 404;
  if (error?.code === "image_asset_pin_limit_reached") return 409;
  return Number(error?.httpStatus || 400);
}

async function currentUser(request, response) {
  return userFromSession(request, response);
}

function imageAssetEndpoints(app) {
  if (!app) return;

  app.get("/image-assets", guards, async (request, response) => {
    try {
      const user = await currentUser(request, response);
      const result = await listImageAssets({
        userId: user?.id || null,
        workspaceId: request.query.workspaceId || null,
        threadId: request.query.threadId || null,
        status: request.query.status || "active",
        page: request.query.page || 1,
        limit: request.query.limit || 24,
      });
      return response.status(200).json({ success: true, ...result });
    } catch (error) {
      return response.status(statusFor(error)).json({
        success: false,
        error: error.code || "image_assets_list_failed",
      });
    }
  });

  app.get(
    "/image-assets/:assetId/preview",
    guards,
    async (request, response) => {
      try {
        const user = await currentUser(request, response);
        const resolved = await previewObjectForAsset({
          assetId: request.params.assetId,
          workspaceId: null,
          userId: user?.id || null,
        });
        if (!resolved) return response.sendStatus(404);
        const body = await DataAccessCenter.contentObject.readWhole(
          resolved.object
        );
        response.setHeader("Content-Type", "image/webp");
        response.setHeader("Content-Length", body.length);
        response.setHeader(
          "Cache-Control",
          "private, max-age=300, no-transform"
        );
        response.setHeader("ETag", `"${resolved.object.plaintextSha256}"`);
        return response.status(200).end(body);
      } catch (error) {
        return response.status(statusFor(error)).json({
          success: false,
          error: error.code || "image_asset_preview_failed",
        });
      }
    }
  );

  app.patch("/image-assets/:assetId", guards, async (request, response) => {
    try {
      const user = await currentUser(request, response);
      const existing = await assetForOwner({
        assetId: request.params.assetId,
        workspaceId: null,
        userId: user?.id || null,
      });
      if (!existing) return response.sendStatus(404);
      const asset = await patchImageAsset({
        assetId: existing.id,
        workspaceId: existing.workspaceId,
        userId: user?.id || null,
        patch: reqBody(request) || {},
      });
      return response.status(200).json({ success: true, asset });
    } catch (error) {
      return response.status(statusFor(error)).json({
        success: false,
        error: error.code || "image_asset_patch_failed",
      });
    }
  });

  app.post("/image-assets/:assetId/sync", guards, async (request, response) => {
    try {
      const user = await currentUser(request, response);
      const existing = await assetForOwner({
        assetId: request.params.assetId,
        workspaceId: null,
        userId: user?.id || null,
      });
      if (!existing) return response.sendStatus(404);
      const asset = await syncImageAsset({
        assetId: existing.id,
        workspaceId: existing.workspaceId,
        forceRefresh: true,
      });
      return response
        .status(200)
        .json({ success: true, asset: publicAsset(asset) });
    } catch (error) {
      return response.status(statusFor(error)).json({
        success: false,
        error: error.code || "image_asset_sync_failed",
      });
    }
  });

  app.delete("/image-assets/:assetId", guards, async (request, response) => {
    try {
      const user = await currentUser(request, response);
      const existing = await assetForOwner({
        assetId: request.params.assetId,
        workspaceId: null,
        userId: user?.id || null,
        includeDeleted: true,
      });
      if (!existing) return response.sendStatus(404);
      const result = await deleteImageAsset({
        assetId: existing.id,
        workspaceId: existing.workspaceId,
        userId: user?.id || null,
      });
      return response.status(result.completed ? 200 : 202).json({
        success: true,
        cleanupPending: !result.completed,
        asset: result.asset,
      });
    } catch (error) {
      return response.status(statusFor(error)).json({
        success: false,
        error: error.code || "image_asset_delete_failed",
      });
    }
  });
}

module.exports = { imageAssetEndpoints };
