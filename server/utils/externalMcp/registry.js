const crypto = require("crypto");
const Ajv = require("ajv");
const { safeJsonParse } = require("../http");
const { AicpCapabilityRegistry } = require("../modulePlatform/aicp/registry");

function dependencies() {
  const { DataAccessCenter } = require("../dataAccess");
  return {
    Workspace: DataAccessCenter.workspace,
    User: DataAccessCenter.user,
    Document: DataAccessCenter.document,
    WorkspaceThread: DataAccessCenter.workspaceThread,
    WorkspaceChats: DataAccessCenter.workspaceChat,
    ToolInvocation: DataAccessCenter.toolInvocation,
    getVectorDbClass: require("../helpers").getVectorDbClass,
    getLLMProvider: require("../helpers").getLLMProvider,
    fileData: require("../files").fileData,
  };
}

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ARGUMENT_BYTES = 128 * 1024;

const DEFINITIONS = Object.freeze([
  {
    name: "athena_list_workspaces",
    description:
      "List Athena workspaces the authorized owner can currently access.",
    scope: "workspace:list",
    workspaceRequired: false,
    capability: "workspace.catalog.read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  {
    name: "athena_workspace_search",
    description:
      "Perform read-only semantic search over one authorized Athena workspace.",
    scope: "workspace:search",
    workspaceRequired: true,
    capability: "workspace.search.read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspace", "query"],
      properties: {
        workspace: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1, maxLength: 4000 },
        topN: { type: "integer", minimum: 1, maximum: 8 },
      },
    },
  },
  {
    name: "athena_list_documents",
    description: "List document metadata for one authorized Athena workspace.",
    scope: "documents:list",
    workspaceRequired: true,
    capability: "workspace.documents.read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspace"],
      properties: {
        workspace: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "athena_read_document",
    description:
      "Read bounded text content from one document in an authorized Athena workspace.",
    scope: "documents:read",
    workspaceRequired: true,
    capability: "workspace.documents.read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspace", "documentId"],
      properties: {
        workspace: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        maxCharacters: { type: "integer", minimum: 1000, maximum: 100000 },
      },
    },
  },
  {
    name: "athena_list_threads",
    description:
      "List conversation threads in one authorized Athena workspace.",
    scope: "threads:list",
    workspaceRequired: true,
    capability: "workspace.threads.read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspace"],
      properties: {
        workspace: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "athena_read_thread",
    description:
      "Read a bounded recent message history from one authorized Athena thread.",
    scope: "threads:read",
    workspaceRequired: true,
    capability: "workspace.threads.read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspace", "thread"],
      properties: {
        workspace: { type: "string", minLength: 1 },
        thread: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "athena_module_describe",
    description:
      "Return a metadata-only description of one registered Athena module.",
    scope: "module:describe",
    workspaceRequired: false,
    capability: "module.describe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["moduleId"],
      properties: {
        moduleId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,62}$" },
      },
    },
  },
  {
    name: "athena_module_self_test",
    description:
      "Run the side-effect-free contract self-test for one Athena module.",
    scope: "module:self-test",
    workspaceRequired: false,
    capability: "module.self-test",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["moduleId"],
      properties: {
        moduleId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,62}$" },
      },
    },
  },
]);

const BY_NAME = new Map(
  DEFINITIONS.map((definition) => [definition.name, definition])
);
const schemaValidator = new Ajv({ allErrors: true, strict: false });
const INPUT_VALIDATORS = new Map(
  DEFINITIONS.map((definition) => [
    definition.name,
    schemaValidator.compile(definition.inputSchema),
  ])
);

function validArguments(toolName, args) {
  const validate = INPUT_VALIDATORS.get(String(toolName));
  return Boolean(validate && validate(args || {}));
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function publicWorkspace(workspace) {
  return {
    slug: workspace.slug,
    name: workspace.name,
    createdAt: workspace.createdAt,
  };
}

function publicModuleDescription(description = {}) {
  return {
    schema: description.schema,
    schemaVersion: description.schemaVersion,
    generatedAt: description.generatedAt,
    module: {
      id: description.module?.id,
      name: description.module?.name,
      version: description.module?.version,
      kind: description.module?.kind,
      criticality: description.module?.criticality,
    },
    capabilities: {
      declared: description.capabilities?.declared || [],
    },
    lifecycle: {
      availabilityTarget: description.lifecycle?.availabilityTarget,
    },
    operations: {
      summary: description.operations?.summary,
    },
    runtime: {
      status: description.runtime?.status,
      ready: description.runtime?.ready,
      lastCheckedAt: description.runtime?.lastCheckedAt,
    },
  };
}

function principalOwnerUserId(principal = {}) {
  const ownerUserId = Number(principal.ownerUserId);
  return Number.isSafeInteger(ownerUserId) && ownerUserId > 0
    ? ownerUserId
    : null;
}

async function ownerUser(principal) {
  const { User } = dependencies();
  const ownerUserId = principalOwnerUserId(principal);
  return ownerUserId ? User.get({ id: ownerUserId }) : null;
}

async function authorizedWorkspace(principal, slug) {
  const { Workspace } = dependencies();
  const grantWorkspace = (principal.workspaces || []).find(
    (workspace) => String(workspace.slug) === String(slug)
  );
  if (!grantWorkspace) {
    const error = new Error("external_mcp_workspace_not_granted");
    error.code = "EXTERNAL_MCP_WORKSPACE_NOT_GRANTED";
    error.httpStatus = 403;
    throw error;
  }
  const user = await ownerUser(principal);
  const workspace = user
    ? await Workspace.getWithUser(user, { slug: String(slug) })
    : await Workspace.get({ slug: String(slug) });
  if (!workspace || Number(workspace.id) !== Number(grantWorkspace.id)) {
    const error = new Error("external_mcp_workspace_access_lost");
    error.code = "EXTERNAL_MCP_WORKSPACE_ACCESS_LOST";
    error.httpStatus = 403;
    throw error;
  }
  return { workspace, user };
}

function cleanSource(source = {}) {
  return {
    title: source.title || source.filename || null,
    text: String(source.text || "").slice(0, 24000),
    score: Number.isFinite(Number(source.score)) ? Number(source.score) : null,
    documentId: source.docId || source.documentId || null,
  };
}

async function executeDefinition(definition, args, principal) {
  const {
    Workspace,
    Document,
    WorkspaceThread,
    WorkspaceChats,
    getVectorDbClass,
    getLLMProvider,
    fileData,
  } = dependencies();
  if (definition.name === "athena_list_workspaces") {
    const user = await ownerUser(principal);
    const rows = user
      ? await Workspace.whereWithUser(user)
      : await Workspace.where({});
    const granted = new Set(
      (principal.workspaces || []).map((workspace) => Number(workspace.id))
    );
    return {
      workspaces: rows
        .filter((workspace) => granted.has(Number(workspace.id)))
        .slice(0, Math.min(Number(args.limit) || 50, 100))
        .map(publicWorkspace),
    };
  }
  if (definition.name === "athena_module_describe")
    return publicModuleDescription(
      await new AicpCapabilityRegistry().describe(args.moduleId)
    );
  if (definition.name === "athena_module_self_test")
    return new AicpCapabilityRegistry().selfTest(args.moduleId);

  const { workspace, user } = await authorizedWorkspace(
    principal,
    args.workspace
  );
  if (definition.name === "athena_list_documents") {
    const documents = await Document.where(
      { workspaceId: workspace.id },
      Math.min(Number(args.limit) || 50, 100),
      { createdAt: "desc" }
    );
    return {
      workspace: publicWorkspace(workspace),
      documents: documents.map((document) => ({
        id: document.docId,
        name: document.filename,
        pinned: Boolean(document.pinned),
        status: document.embeddingStatus,
        createdAt: document.createdAt,
      })),
    };
  }
  if (definition.name === "athena_read_document") {
    const document = await Document.get({
      workspaceId: workspace.id,
      docId: String(args.documentId),
    });
    if (!document)
      throw Object.assign(new Error("external_mcp_document_not_found"), {
        code: "EXTERNAL_MCP_DOCUMENT_NOT_FOUND",
        httpStatus: 404,
      });
    const parsed = await fileData(document.docpath);
    const maxCharacters = Math.min(
      Math.max(Number(args.maxCharacters) || 50000, 1000),
      100000
    );
    return {
      id: document.docId,
      name: document.filename,
      metadata: ((metadata) => ({
        title: metadata.title || null,
        description: metadata.description || null,
        pageCount: Number.isFinite(Number(metadata.pageCount))
          ? Number(metadata.pageCount)
          : null,
      }))(safeJsonParse(document.metadata, {})),
      content: String(parsed?.pageContent || "").slice(0, maxCharacters),
      truncated: String(parsed?.pageContent || "").length > maxCharacters,
    };
  }
  if (definition.name === "athena_workspace_search") {
    const VectorDb = getVectorDbClass();
    if (!(await VectorDb.hasNamespace(workspace.slug)))
      return { found: false, results: [] };
    const result = await VectorDb.performSimilaritySearch({
      namespace: workspace.slug,
      input: String(args.query).trim(),
      LLMConnector: getLLMProvider({
        provider: workspace.chatProvider,
        model: workspace.chatModel,
      }),
      similarityThreshold: workspace.similarityThreshold,
      topN: Math.min(Number(args.topN) || workspace.topN || 4, 8),
      rerank: workspace.vectorSearchMode === "rerank",
    });
    return {
      found: Boolean(result?.sources?.length),
      results: (result?.sources || []).map(cleanSource),
    };
  }
  if (definition.name === "athena_list_threads") {
    const where = {
      workspace_id: workspace.id,
      archivedAt: null,
      ...(user ? { OR: [{ user_id: user.id }, { user_id: null }] } : {}),
    };
    const threads = await WorkspaceThread.where(
      where,
      Math.min(Number(args.limit) || 50, 100),
      { lastUpdatedAt: "desc" }
    );
    return {
      threads: threads.map((thread) => ({
        slug: thread.slug,
        title: thread.title || thread.name,
        updatedAt: thread.lastUpdatedAt,
      })),
    };
  }
  if (definition.name === "athena_read_thread") {
    const where = {
      workspace_id: workspace.id,
      OR: [
        { slug: String(args.thread) },
        ...(Number.isSafeInteger(Number(args.thread))
          ? [{ id: Number(args.thread) }]
          : []),
      ],
      ...(user
        ? { AND: [{ OR: [{ user_id: user.id }, { user_id: null }] }] }
        : {}),
    };
    const thread = (await WorkspaceThread.where(where, 1))[0];
    if (!thread)
      throw Object.assign(new Error("external_mcp_thread_not_found"), {
        code: "EXTERNAL_MCP_THREAD_NOT_FOUND",
        httpStatus: 404,
      });
    const messages = await WorkspaceChats.where(
      {
        workspaceId: workspace.id,
        thread_id: thread.id,
        include: true,
        deletedAt: null,
      },
      Math.min(Number(args.limit) || 20, 50),
      { id: "desc" },
      null,
      { attachmentMode: "reference" }
    );
    return {
      thread: {
        slug: thread.slug,
        title: thread.title || thread.name,
      },
      messages: messages.reverse().map((message) => ({
        ...(message.public_id ? { id: message.public_id } : {}),
        prompt: String(message.prompt || "").slice(0, 16000),
        response: String(message.response?.text || "").slice(0, 32000),
        createdAt: message.createdAt,
      })),
    };
  }
  throw Object.assign(new Error("external_mcp_tool_not_implemented"), {
    code: "EXTERNAL_MCP_TOOL_NOT_IMPLEMENTED",
    httpStatus: 501,
  });
}

function sanitizeResult(result) {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) <= MAX_RESULT_BYTES) return result;
  const previewBudget = MAX_RESULT_BYTES - 4096;
  let preview = Buffer.from(json).subarray(0, previewBudget).toString("utf8");
  while (Buffer.byteLength(preview) > previewBudget)
    preview = preview.slice(0, -1);
  return {
    truncated: true,
    resultSha256: stableHash(result),
    preview,
  };
}

const ExternalMcpToolRegistry = {
  definitions: () =>
    DEFINITIONS.map((definition) => ({ ...definition, risk: "read-only" })),
  catalog(principal) {
    const scopes = new Set(principal.scopes || []);
    const tools = new Set(principal.tools || []);
    return DEFINITIONS.filter(
      (definition) => tools.has(definition.name) && scopes.has(definition.scope)
    ).map(
      ({
        scope: _scope,
        workspaceRequired: _workspaceRequired,
        capability: _capability,
        ...definition
      }) => ({
        ...definition,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      })
    );
  },
  async invoke({
    toolName,
    args = {},
    principal,
    approvalRequestId = crypto.randomUUID(),
  }) {
    const { ToolInvocation } = dependencies();
    const definition = BY_NAME.get(String(toolName));
    if (
      !definition ||
      !(principal.tools || []).includes(definition.name) ||
      !(principal.scopes || []).includes(definition.scope)
    )
      throw Object.assign(new Error("external_mcp_tool_denied"), {
        code: "EXTERNAL_MCP_TOOL_DENIED",
        httpStatus: 403,
      });
    if (Buffer.byteLength(JSON.stringify(args || {})) > MAX_ARGUMENT_BYTES)
      throw Object.assign(new Error("external_mcp_arguments_too_large"), {
        code: "EXTERNAL_MCP_ARGUMENTS_TOO_LARGE",
        httpStatus: 413,
      });
    if (!validArguments(definition.name, args))
      throw Object.assign(new Error("external_mcp_arguments_invalid"), {
        code: "EXTERNAL_MCP_ARGUMENTS_INVALID",
        httpStatus: 400,
      });
    const workspaceSlug = definition.workspaceRequired
      ? String(args.workspace || "")
      : null;
    if (definition.workspaceRequired && !workspaceSlug)
      throw Object.assign(new Error("external_mcp_workspace_required"), {
        code: "EXTERNAL_MCP_WORKSPACE_REQUIRED",
        httpStatus: 400,
      });
    const scope = {
      grantId: principal.grantId,
      clientId: principal.clientId,
      workspaceSlug,
      capability: definition.capability,
    };
    await ToolInvocation.startExternalExecution({
      approvalRequestId: String(approvalRequestId),
      ownerUserId: principalOwnerUserId(principal),
      ownerAuthUserId: principal.ownerAuthUserId
        ? String(principal.ownerAuthUserId)
        : null,
      toolName: definition.name,
      scope,
      args,
    });
    try {
      const result = sanitizeResult(
        await executeDefinition(definition, args, principal)
      );
      await ToolInvocation.completeExternalExecution({
        approvalRequestId,
        result,
      });
      return result;
    } catch (error) {
      await ToolInvocation.failExternalExecution({
        approvalRequestId,
        reasonCode: String(error.code || "external_mcp_tool_failed").slice(
          0,
          120
        ),
      }).catch(() => {});
      throw error;
    }
  },
};

module.exports = {
  DEFINITIONS,
  ExternalMcpToolRegistry,
  MAX_ARGUMENT_BYTES,
  MAX_RESULT_BYTES,
  validArguments,
  sanitizeResult,
  principalOwnerUserId,
};
