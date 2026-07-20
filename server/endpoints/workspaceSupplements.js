const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { handleFileUpload } = require("../utils/files/multer");
const { fileData } = require("../utils/files");
const { DataAccessCenter } = require("../utils/dataAccess");
const {
  WORKSPACE_SUPPLEMENT_PROMPT_TEMPLATE,
  WORKSPACE_SUPPLEMENT_KIND_LABELS,
  WORKSPACE_SUPPLEMENT_KINDS,
  WORKSPACE_SUPPLEMENT_SCOPE_TYPES,
  normalizeScopeType,
  normalizeSupplementKind,
  workspaceSupplementPromptForKind,
} = require("../utils/knowledgeGraph/supplementConstants");
const {
  ingestUploadedSupplementFile,
  ingestTextSupplement,
  parseStructureJsonFromMarkdown,
} = require("../utils/knowledgeGraph/supplementIngestor");
const {
  invalidateWorkspaceOverviewCache,
} = require("../utils/workspaceOverview");
const {
  listWorkspaceSupplementsWithToolFields,
  resolveWorkspaceSupplementToolManifest,
} = require("../utils/knowledgeGraph/workspaceSupplementToolManifest");
const WorkspaceSupplement = DataAccessCenter.workspaceSupplement.model;
const WorkspaceSupplementRepository = DataAccessCenter.repositoryObject(
  "workspaceSupplement"
);

function bool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function workspaceSupplementMetadata({
  scopeType,
  primaryDocumentId,
  supplementKind,
  extra = {},
}) {
  return {
    ...extra,
    supplementScope: "workspace",
    scopeType: normalizeScopeType(scopeType),
    primaryDocumentId: primaryDocumentId || null,
    supplementKind: normalizeSupplementKind(supplementKind),
    createdAt: new Date().toISOString(),
  };
}

async function parsedStructureMetadata({ document, supplementKind, metadata }) {
  if (supplementKind !== "structure_json") return metadata;
  const data = await fileData(document.docpath).catch(() => null);
  const parsed = parseStructureJsonFromMarkdown(data?.pageContent || "");
  if (!parsed.valid) {
    return {
      ...metadata,
      structureJsonValidation: {
        valid: false,
        error: parsed.error,
        source: "existing_document_bind",
      },
    };
  }
  return {
    ...metadata,
    parsedStructure: parsed.parsedStructure,
    structureJsonValidation: { valid: true, source: "existing_document_bind" },
  };
}

function workspaceSupplementEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/workspace-supplements/prompt",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      const requestedKind = request.query.supplementKind || "reading_guide";
      const isValidKind = WORKSPACE_SUPPLEMENT_KINDS.includes(requestedKind);
      const supplementKind = isValidKind
        ? normalizeSupplementKind(requestedKind)
        : "reading_guide";
      if (requestedKind && !isValidKind) {
        console.debug(
          `[WorkspaceSupplement] invalid supplementKind "${requestedKind}" for prompt; fallback to reading_guide`
        );
      }
      const prompt = workspaceSupplementPromptForKind(supplementKind);
      response.status(200).json({
        success: true,
        prompt: prompt.prompt || WORKSPACE_SUPPLEMENT_PROMPT_TEMPLATE,
        supplementKind: prompt.supplementKind,
        supplementKindLabel: prompt.label,
        supplementKinds: WORKSPACE_SUPPLEMENT_KINDS,
        supplementKindLabels: WORKSPACE_SUPPLEMENT_KIND_LABELS,
        scopeTypes: WORKSPACE_SUPPLEMENT_SCOPE_TYPES,
      });
    }
  );

  app.get(
    "/workspace/:slug/workspace-supplements",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const supplements = await listWorkspaceSupplementsWithToolFields({
          workspaceId: workspace.id,
          scopeType: request.query.scopeType || null,
          primaryDocumentId:
            request.query.primaryDocumentId === undefined
              ? undefined
              : request.query.primaryDocumentId,
        });
        response.status(200).json({ success: true, supplements });
      } catch (error) {
        console.error("[WorkspaceSupplement] list failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/workspace-supplements/tool-manifest-preview",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const manifest = await resolveWorkspaceSupplementToolManifest({
          workspaceId: workspace.id,
          scopeType: request.query.scopeType || null,
          primaryDocumentId: request.query.primaryDocumentId || null,
        });
        response.status(200).json({ success: true, manifest });
      } catch (error) {
        console.error(
          "[WorkspaceSupplement] tool manifest preview failed",
          error
        );
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/workspace-supplements/bind",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const body = reqBody(request);
        const supplementKind = normalizeSupplementKind(
          body?.supplementKind || "other"
        );
        const document = await WorkspaceSupplementRepository.documentByDocId({
          workspaceId: workspace.id,
          documentId: body?.documentId,
        });
        if (!document) {
          response
            .status(400)
            .json({ success: false, error: "document_not_found" });
          return;
        }
        const metadata = await parsedStructureMetadata({
          document,
          supplementKind,
          metadata: workspaceSupplementMetadata({
            scopeType: body?.scopeType,
            primaryDocumentId: body?.primaryDocumentId,
            supplementKind,
            extra: body?.metadata || {},
          }),
        });
        if (
          supplementKind === "structure_json" &&
          metadata.structureJsonValidation?.valid === false &&
          !bool(body?.allowDowngrade)
        ) {
          response.status(400).json({
            success: false,
            error: "invalid_structure_json",
            message: metadata.structureJsonValidation.error,
          });
          return;
        }
        const result = await WorkspaceSupplement.upsert({
          workspaceId: workspace.id,
          scopeType: body?.scopeType,
          primaryDocumentId: body?.primaryDocumentId,
          documentId: document.docId,
          supplementKind:
            supplementKind === "structure_json" &&
            metadata.structureJsonValidation?.valid === false
              ? "reading_guide"
              : supplementKind,
          priority: body?.priority || 0,
          metadata,
        });
        if (result.success)
          invalidateWorkspaceOverviewCache({ workspaceId: workspace.id });
        response.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        console.error("[WorkspaceSupplement] bind failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/workspace-supplements/upload",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = request.body || {};
        const supplementKind = normalizeSupplementKind(
          body.supplementKind || "other"
        );
        const metadata = workspaceSupplementMetadata({
          scopeType: body.scopeType,
          primaryDocumentId: body.primaryDocumentId,
          supplementKind,
          extra: { source: "workspace_supplement_upload" },
        });
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
        const result = await WorkspaceSupplement.upsert({
          workspaceId: workspace.id,
          scopeType: body.scopeType,
          primaryDocumentId: body.primaryDocumentId,
          documentId: ingest.document.docId,
          supplementKind,
          priority: body.priority || 0,
          metadata,
        });
        if (result.success)
          invalidateWorkspaceOverviewCache({ workspaceId: workspace.id });
        response.status(result.success ? 200 : 400).json({
          ...result,
          document: ingest.document,
        });
      } catch (error) {
        console.error("[WorkspaceSupplement] upload failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/workspace-supplements/text",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const supplementKind = normalizeSupplementKind(
          body?.supplementKind || "reading_guide"
        );
        const metadata = workspaceSupplementMetadata({
          scopeType: body?.scopeType,
          primaryDocumentId: body?.primaryDocumentId,
          supplementKind,
          extra: { source: "workspace_supplement_text" },
        });
        const ingest = await ingestTextSupplement({
          workspace,
          title: body?.title || "全书补充资料",
          text: body?.text,
          userId: user?.id || null,
          metadata,
          allowStructureJsonDowngrade: bool(body?.allowDowngrade),
        });
        if (!ingest.success) {
          response.status(400).json(ingest);
          return;
        }
        const result = await WorkspaceSupplement.upsert({
          workspaceId: workspace.id,
          scopeType: body?.scopeType,
          primaryDocumentId: body?.primaryDocumentId,
          documentId: ingest.document.docId,
          supplementKind: ingest.supplementKind || supplementKind,
          priority: body?.priority || 0,
          metadata: ingest.metadata || metadata,
        });
        if (result.success)
          invalidateWorkspaceOverviewCache({ workspaceId: workspace.id });
        response.status(result.success ? 200 : 400).json({
          ...result,
          document: ingest.document,
        });
      } catch (error) {
        console.error("[WorkspaceSupplement] text failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.delete(
    "/workspace/:slug/workspace-supplements/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const result = await WorkspaceSupplement.delete({
          workspaceId: workspace.id,
          id: request.params.id,
        });
        if (result.success)
          invalidateWorkspaceOverviewCache({ workspaceId: workspace.id });
        response.status(result.success ? 200 : 404).json(result);
      } catch (error) {
        console.error("[WorkspaceSupplement] delete failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { workspaceSupplementEndpoints };
