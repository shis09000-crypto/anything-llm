const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { reqBody, userFromSession } = require("../utils/http");
const {
  ReaderLibraryService,
  libraryResponse,
} = require("../services/readerLibraryService");

async function currentUserId(request, response) {
  const user =
    response.locals?.user || (await userFromSession(request, response));
  return Number(user?.id || 0) || null;
}

function readerLibraryEndpoints(app) {
  if (!app) return;
  const middleware = [validatedRequest, flexUserRoleValid([ROLES.all])];

  app.get("/reader-library", middleware, async (request, response) => {
    try {
      const userId = await currentUserId(request, response);
      if (!userId)
        return response.status(401).json({
          success: false,
          error: "user_session_required",
        });
      const result = await ReaderLibraryService.list({ userId });
      return response.status(200).json(libraryResponse(result));
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: error.message || "Failed to list reader library.",
      });
    }
  });

  app.post(
    "/reader-library/bootstrap",
    middleware,
    async (request, response) => {
      try {
        const userId = await currentUserId(request, response);
        if (!userId)
          return response.status(401).json({
            success: false,
            error: "user_session_required",
          });
        const body = reqBody(request) || {};
        const result = await ReaderLibraryService.bootstrap({
          userId,
          bookshelf: Array.isArray(body.bookshelf) ? body.bookshelf : [],
          categories: Array.isArray(body.categories) ? body.categories : [],
        });
        return response.status(200).json(libraryResponse(result));
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: error.message || "Failed to bootstrap reader library.",
        });
      }
    }
  );

  app.patch(
    "/reader-library/items/:itemId",
    middleware,
    async (request, response) => {
      try {
        const userId = await currentUserId(request, response);
        if (!userId)
          return response.status(401).json({
            success: false,
            error: "user_session_required",
          });
        const result = await ReaderLibraryService.patchItem({
          userId,
          itemId: request.params.itemId,
          patch: reqBody(request) || {},
        });
        if (!result)
          return response.status(404).json({
            success: false,
            error: "reader_library_item_not_found",
          });
        return response.status(200).json(libraryResponse(result));
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: error.message || "Failed to patch reader library item.",
        });
      }
    }
  );

  app.delete(
    "/reader-library/items/:itemId",
    middleware,
    async (request, response) => {
      try {
        const userId = await currentUserId(request, response);
        if (!userId)
          return response.status(401).json({
            success: false,
            error: "user_session_required",
          });
        const result = await ReaderLibraryService.softDeleteItem({
          userId,
          itemId: request.params.itemId,
        });
        return response.status(200).json(libraryResponse(result));
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: error.message || "Failed to delete reader library item.",
        });
      }
    }
  );

  app.patch(
    "/reader-library/categories/:categoryId",
    middleware,
    async (request, response) => {
      try {
        const userId = await currentUserId(request, response);
        if (!userId)
          return response.status(401).json({
            success: false,
            error: "user_session_required",
          });
        const result = await ReaderLibraryService.patchCategory({
          userId,
          categoryId: request.params.categoryId,
          patch: reqBody(request) || {},
        });
        return response.status(200).json(libraryResponse(result));
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: error.message || "Failed to patch reader library category.",
        });
      }
    }
  );

  app.delete(
    "/reader-library/categories/:categoryId",
    middleware,
    async (request, response) => {
      try {
        const userId = await currentUserId(request, response);
        if (!userId)
          return response.status(401).json({
            success: false,
            error: "user_session_required",
          });
        const result = await ReaderLibraryService.patchCategory({
          userId,
          categoryId: request.params.categoryId,
          patch: { deleted: true },
        });
        return response.status(200).json(libraryResponse(result));
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: error.message || "Failed to delete reader library category.",
        });
      }
    }
  );

  app.post(
    "/reader-library/reconcile",
    middleware,
    async (request, response) => {
      try {
        const userId = await currentUserId(request, response);
        if (!userId)
          return response.status(401).json({
            success: false,
            error: "user_session_required",
          });
        const body = reqBody(request) || {};
        const result = await ReaderLibraryService.reconcile({
          userId,
          documents: Array.isArray(body.documents) ? body.documents : [],
          workspaceSlug: body.workspaceSlug || null,
        });
        return response.status(200).json(libraryResponse(result));
      } catch (error) {
        return response.status(500).json({
          success: false,
          error: error.message || "Failed to reconcile reader library.",
        });
      }
    }
  );
}

module.exports = { readerLibraryEndpoints };
