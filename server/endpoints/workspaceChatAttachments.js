const { DataAccessCenter } = require("../utils/dataAccess");
const {
  completeUpload,
  createUpload,
  putUploadPart,
} = require("../utils/contentObjects/chatPayload");
const { contentObjectLimits } = require("../utils/contentObjects/policy");
const { createImageAssetForUpload } = require("../utils/imageAssets/service");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");

function errorStatus(error) {
  if (
    String(error?.code || "")
      .toLowerCase()
      .includes("not_found")
  )
    return 404;
  if (
    ["chat_attachment_too_large", "chat_attachment_part_too_large"].includes(
      error?.code
    )
  )
    return 413;
  return 400;
}

function parseRange(value, size) {
  const match = String(value || "").match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    return null;
  return { start, end: Math.min(end, size - 1) };
}

async function sendContent(request, response, resolved) {
  if (!resolved) return response.sendStatus(404);
  const { object } = resolved;
  if (!Number.isSafeInteger(object.plaintextSize) || object.plaintextSize <= 0)
    return response.status(500).json({
      success: false,
      error: "chat_content_size_invalid",
    });
  const etag = `"${object.plaintextSha256}"`;
  if (request.header("If-None-Match") === etag)
    return response.status(304).end();
  const requestedRange = request.header("Range");
  const range = requestedRange
    ? parseRange(requestedRange, object.plaintextSize)
    : { start: 0, end: object.plaintextSize - 1 };
  if (!range) {
    response.setHeader("Content-Range", `bytes */${object.plaintextSize}`);
    return response.status(416).end();
  }
  const body = await DataAccessCenter.contentObject.readRange(object, range);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "private, max-age=300, no-transform");
  response.setHeader(
    "Content-Type",
    object.mimeType || "application/octet-stream"
  );
  response.setHeader("Content-Length", body.length);
  response.setHeader("ETag", etag);
  if (requestedRange) {
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${object.plaintextSize}`
    );
    return response.status(206).end(body);
  }
  return response.status(200).end(body);
}

function workspaceChatAttachmentEndpoints(app) {
  if (!app) return;
  const guards = [
    validatedRequest,
    flexUserRoleValid([ROLES.all]),
    validWorkspaceSlug,
  ];

  app.post(
    "/workspace/:slug/chat-attachments/uploads",
    guards,
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = reqBody(request) || {};
        const upload = await createUpload({
          workspaceId: workspace.id,
          userId: user?.id || null,
          name: body.name,
          mime: body.mime,
          size: body.byteSize,
          sha256: body.sha256,
        });
        return response.status(201).json({
          success: true,
          uploadId: upload.id,
          partBytes: contentObjectLimits().uploadPartBytes,
          expiresAt: upload.expiresAt,
        });
      } catch (error) {
        return response.status(errorStatus(error)).json({
          success: false,
          error: error.code || "chat_attachment_upload_create_failed",
          ...(error.details || {}),
        });
      }
    }
  );

  app.put(
    "/workspace/:slug/chat-attachments/uploads/:uploadId/parts/:partNumber",
    guards,
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        if (!Buffer.isBuffer(request.body)) {
          return response.status(415).json({
            success: false,
            error: "chat_attachment_part_content_type_invalid",
          });
        }
        const part = await putUploadPart({
          uploadId: request.params.uploadId,
          workspaceId: workspace.id,
          userId: user?.id || null,
          partNumber: request.params.partNumber,
          body: request.body,
        });
        return response.status(200).json({ success: true, ...part });
      } catch (error) {
        return response.status(errorStatus(error)).json({
          success: false,
          error: error.code || "chat_attachment_part_failed",
          ...(error.details || {}),
        });
      }
    }
  );

  app.post(
    "/workspace/:slug/chat-attachments/uploads/:uploadId/complete",
    guards,
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const upload = await completeUpload({
          uploadId: request.params.uploadId,
          workspaceId: workspace.id,
          userId: user?.id || null,
        });
        const imageAsset = await createImageAssetForUpload({
          workspaceId: workspace.id,
          userId: user?.id || null,
          upload,
        });
        return response.status(200).json({
          success: true,
          attachment: {
            uploadId: upload.id,
            contentObjectId: upload.contentObjectId,
            name: upload.displayName,
            mime: upload.mimeType,
            byteSize: upload.receivedBytes,
            ...(imageAsset
              ? {
                  assetId: imageAsset.id,
                  imageAssetId: imageAsset.id,
                  previewUrl: imageAsset.previewUrl,
                  width: imageAsset.width,
                  height: imageAsset.height,
                  animated: imageAsset.animated,
                  providerSyncStatus: imageAsset.providerSyncStatus,
                  providerFailureCode: imageAsset.providerFailureCode,
                }
              : {}),
          },
        });
      } catch (error) {
        return response.status(errorStatus(error)).json({
          success: false,
          error: error.code || "chat_attachment_upload_complete_failed",
          ...(error.details || {}),
        });
      }
    }
  );

  app.get(
    "/workspace/:slug/chat-attachments/:attachmentId/content",
    guards,
    async (request, response) => {
      try {
        const resolved =
          await DataAccessCenter.contentObject.attachmentForWorkspace({
            attachmentId: request.params.attachmentId,
            workspaceId: response.locals.workspace.id,
          });
        return await sendContent(request, response, resolved);
      } catch (error) {
        console.error("[ChatAttachment] content read failed", {
          code: error.code || error.name,
        });
        return response.status(error.httpStatus || 500).json({
          success: false,
          error: "chat_attachment_read_failed",
        });
      }
    }
  );

  app.get(
    "/workspace/:slug/chat-content/:refId/content",
    guards,
    async (request, response) => {
      try {
        const resolved =
          await DataAccessCenter.contentObject.contentRefForWorkspace({
            refId: request.params.refId,
            workspaceId: response.locals.workspace.id,
          });
        return await sendContent(request, response, resolved);
      } catch (error) {
        console.error("[ChatContent] content read failed", {
          code: error.code || error.name,
        });
        return response.status(error.httpStatus || 500).json({
          success: false,
          error: "chat_content_read_failed",
        });
      }
    }
  );
}

module.exports = { parseRange, workspaceChatAttachmentEndpoints };
