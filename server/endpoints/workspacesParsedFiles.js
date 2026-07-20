const { reqBody, multiUserMode, userFromSession } = require("../utils/http");
const { handleFileUpload } = require("../utils/files/multer");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { CollectorApi } = require("../utils/collectorApi");
const { DataAccessCenter } = require("../utils/dataAccess");
const { getAuthorizedParsedFile } = require("../utils/authz/resourceAccess");
const {
  deleteDocxSource,
  saveDocxSource,
} = require("../utils/documentSources");

function workspaceParsedFilesEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/parsed-files",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const threadSlug = request.query.threadSlug || null;
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const thread = threadSlug
          ? await DataAccessCenter.workspaceThread.get({
              slug: String(threadSlug),
            })
          : null;
        const { files, contextWindow, currentContextTokenCount } =
          await DataAccessCenter.workspaceParsedFile.getContextMetadataAndLimits(
            workspace,
            thread || null,
            multiUserMode(response) ? user : null
          );

        return response
          .status(200)
          .json({ files, contextWindow, currentContextTokenCount });
      } catch (e) {
        console.error(e.message, e);
        return response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/delete-parsed-files",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async function (request, response) {
      try {
        const { fileIds = [] } = reqBody(request);
        if (!fileIds.length) return response.sendStatus(400).end();
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const success = await DataAccessCenter.workspaceParsedFile.delete({
          id: {
            in: fileIds.map((id) => parseInt(id)),
          },
          ...(user ? { userId: user.id } : {}),
          workspaceId: workspace.id,
        });
        return response.status(success ? 200 : 403).end();
      } catch (e) {
        console.error(e.message, e);
        return response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/embed-parsed-file/:fileId",
    [
      validatedRequest,
      // Embed is still an admin/manager only feature
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
    ],
    async function (request, response) {
      const { fileId = null } = request.params;
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;

        if (!fileId) return response.sendStatus(400).end();
        const parsedFile = await getAuthorizedParsedFile({
          request,
          response,
          workspace,
          fileId,
        });
        if (!parsedFile) return response.sendStatus(404).end();

        const { success, error, document } =
          await DataAccessCenter.workspaceParsedFile.moveToDocumentsAndEmbed(
            user,
            fileId,
            workspace,
            parsedFile
          );

        if (!success) {
          return response.status(500).json({
            success: false,
            error: error || "Failed to embed file",
          });
        }

        await Telemetry.sendTelemetry("document_embedded");
        await EventLogs.logEvent(
          "document_embedded",
          {
            documentName: document?.name || "unknown",
            workspaceId: workspace.id,
          },
          user?.id
        );

        return response.status(200).json({
          success: true,
          error: null,
          document,
        });
      } catch (e) {
        console.error(e.message, e);
        return response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/parse",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      handleFileUpload,
      validWorkspaceSlug,
    ],
    async function (request, response) {
      let retainedDocxSource = null;
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const Collector = new CollectorApi();
        const { filename, originalname } = request.file;
        const processingOnline = await Collector.online();

        if (!processingOnline) {
          return response.status(500).json({
            success: false,
            error: `Document processing API is not online. Document ${originalname} will not be parsed.`,
          });
        }

        retainedDocxSource = saveDocxSource(request.file.path);

        const { success, reason, documents } = await Collector.parseDocument(
          filename,
          { displayName: originalname }
        );
        if (!success || !documents?.[0]) {
          if (retainedDocxSource) {
            deleteDocxSource(retainedDocxSource);
            retainedDocxSource = null;
          }
          return response.status(500).json({
            success: false,
            error: reason || "No document returned from collector",
          });
        }

        // Get thread ID if we have a slug
        const { threadSlug = null } = reqBody(request);
        const thread = threadSlug
          ? await DataAccessCenter.workspaceThread.get({
              slug: String(threadSlug),
              workspace_id: workspace.id,
              user_id: user?.id || null,
            })
          : null;
        const files = await Promise.all(
          documents.map(async (doc, documentIndex) => {
            const metadata = { ...doc };
            // Strip out pageContent
            delete metadata.pageContent;
            if (retainedDocxSource && documentIndex === 0) {
              metadata.docxSource = {
                token: retainedDocxSource,
                originalName: originalname,
              };
            }
            const filename = `${originalname}-${doc.id}.json`;
            const { file, error: dbError } =
              await DataAccessCenter.workspaceParsedFile.create({
                filename,
                workspaceId: workspace.id,
                userId: user?.id || null,
                threadId: thread?.id || null,
                metadata: JSON.stringify(metadata),
                tokenCountEstimate: doc.token_count_estimate || 0,
              });

            if (dbError) throw new Error(dbError);
            return file;
          })
        );

        Collector.log(`Document ${originalname} parsed successfully.`);
        await EventLogs.logEvent(
          "document_uploaded_to_chat",
          {
            documentName: originalname,
            workspace: workspace.slug,
            thread: thread?.name || null,
          },
          user?.id
        );

        return response.status(200).json({
          success: true,
          error: null,
          files,
        });
      } catch (e) {
        if (retainedDocxSource) deleteDocxSource(retainedDocxSource);
        console.error(e.message, e);
        return response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );
}

module.exports = { workspaceParsedFilesEndpoints };
