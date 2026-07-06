const { DataAccessCenter } = require("../utils/dataAccess");
const { normalizePath, documentsPath, isWithin } = require("../utils/files");
const { reqBody, multiUserMode, userFromSession } = require("../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { getAuthorizedWorkspace } = require("../utils/authz/resourceAccess");
const fs = require("fs");
const path = require("path");

function documentEndpoints(app) {
  if (!app) return;
  function workspaceIdentifierForRequest(request) {
    const body = reqBody(request) || {};
    return {
      workspaceSlug: request.query.workspaceSlug || body.workspaceSlug || null,
      workspaceId: request.query.workspaceId || body.workspaceId || null,
    };
  }

  async function resolveWorkspaceForRequest(request, response) {
    const { workspaceSlug, workspaceId } =
      workspaceIdentifierForRequest(request);
    if (workspaceSlug) {
      const user = await userFromSession(request, response);
      return multiUserMode(response)
        ? await DataAccessCenter.workspace.getWithUser(user, {
            slug: String(workspaceSlug),
          })
        : await DataAccessCenter.workspace.get({
            slug: String(workspaceSlug),
          });
    }
    if (workspaceId)
      return await DataAccessCenter.workspace.get({ id: Number(workspaceId) });
    return null;
  }

  app.get(
    "/document/index-status",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { workspaceSlug, workspaceId } =
          workspaceIdentifierForRequest(request);
        if (!workspaceSlug && !workspaceId) {
          response.status(400).json({
            success: false,
            message: "workspaceSlug or workspaceId is required.",
          });
          return;
        }

        const workspace = await getAuthorizedWorkspace({
          request,
          response,
          workspaceSlug,
          workspaceId,
        });
        if (!workspace) {
          response.status(404).json({
            success: false,
            message: "Workspace not found.",
          });
          return;
        }

        const rows = await DataAccessCenter.documentIndexStatus.where({
          workspaceId: workspace.id,
          filePath: request.query.filePath || null,
          docId: request.query.docId || null,
        });
        response.status(200).json({ statuses: rows });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          message: `Failed to get index status: ${e.message}`,
        });
      }
    }
  );

  app.patch(
    "/document/index-status",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const workspace = await resolveWorkspaceForRequest(request, response);
        const body = reqBody(request);
        const status = await DataAccessCenter.documentIndexStatus.manualUpdate({
          workspaceId: workspace?.id || body.workspaceId,
          filePath: body.filePath,
          docId: body.docId || null,
          indexStatus: body.indexStatus,
          errorMessage: body.errorMessage ?? null,
          chunkCount: body.chunkCount ?? null,
          embeddingCount: body.embeddingCount ?? null,
        });
        response.status(200).json({ success: true, status });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          message: `Failed to update index status: ${e.message}`,
        });
      }
    }
  );

  app.post(
    "/document/create-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const storagePath = path.join(documentsPath, normalizePath(name));
        if (!isWithin(path.resolve(documentsPath), path.resolve(storagePath)))
          throw new Error("Invalid folder name.");

        if (fs.existsSync(storagePath)) {
          response.status(500).json({
            success: false,
            message: "Folder by that name already exists",
          });
          return;
        }

        fs.mkdirSync(storagePath, { recursive: true });
        response.status(200).json({ success: true, message: null });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          message: `Failed to create folder: ${e.message} `,
        });
      }
    }
  );

  app.post(
    "/document/move-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { files } = reqBody(request);
        const docpaths = files.map(({ from }) => from);
        const documents = await DataAccessCenter.document.where({
          docpath: { in: docpaths },
        });

        const embeddedFiles = documents.map((doc) => doc.docpath);
        const moveableFiles = files.filter(
          ({ from }) => !embeddedFiles.includes(from)
        );

        const movePromises = moveableFiles.map(({ from, to }) => {
          const sourcePath = path.join(documentsPath, normalizePath(from));
          const destinationPath = path.join(documentsPath, normalizePath(to));

          return new Promise((resolve, reject) => {
            if (
              !isWithin(documentsPath, sourcePath) ||
              !isWithin(documentsPath, destinationPath)
            )
              return reject("Invalid file location");

            fs.rename(sourcePath, destinationPath, (err) => {
              if (err) {
                console.error(`Error moving file ${from} to ${to}:`, err);
                reject(err);
              } else {
                resolve();
              }
            });
          });
        });

        Promise.all(movePromises)
          .then(() => {
            const unmovableCount = files.length - moveableFiles.length;
            if (unmovableCount > 0) {
              response.status(200).json({
                success: true,
                message: `${unmovableCount}/${files.length} files not moved. Unembed them from all workspaces.`,
              });
            } else {
              response.status(200).json({
                success: true,
                message: null,
              });
            }
          })
          .catch((err) => {
            console.error("Error moving files:", err);
            response
              .status(500)
              .json({ success: false, message: "Failed to move some files." });
          });
      } catch (e) {
        console.error(e);
        response
          .status(500)
          .json({ success: false, message: "Failed to move files." });
      }
    }
  );
}

module.exports = { documentEndpoints };
