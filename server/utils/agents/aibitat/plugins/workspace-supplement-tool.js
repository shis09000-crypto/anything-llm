const {
  TOOL_NAME,
  TOOL_LIMIT_MESSAGE,
  MAX_LIMIT,
  manifestDescription,
  resolveWorkspaceSupplementToolContent,
} = require("../../../knowledgeGraph/workspaceSupplementToolManifest");

function parseResult(result) {
  try {
    return JSON.parse(result);
  } catch {
    return {};
  }
}

function recordSupplementToolEvent(aibitat, payload = {}) {
  if (!Array.isArray(aibitat._agentEvents)) aibitat._agentEvents = [];
  aibitat._agentEvents.push({
    type: "tool_usage",
    toolName: TOOL_NAME,
    createdAt: Date.now(),
    mode: payload.mode,
    supplementKind: payload.supplementKind,
    supplementId: payload.supplementId,
    documentTitle: payload.documentTitle,
    query: payload.query,
    reason: payload.reason,
    returnedCount: payload.returnedCount,
    truncatedCount: payload.truncatedCount,
    status: payload.status,
    content: payload.content,
  });
}

const workspaceSupplementTool = {
  name: TOOL_NAME,
  startupConfig: {
    params: {
      manifest: {},
      primaryDocumentId: null,
    },
  },
  plugin: function ({ manifest = null, primaryDocumentId = null } = {}) {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description: manifestDescription(
            manifest || aibitat.handlerProps?.workspaceSupplementManifest || {}
          ),
          examples: [
            {
              prompt: "Explain the core concepts using the concept index.",
              call: JSON.stringify({
                mode: "kind",
                supplementKind: "concept_index",
                query: "core concepts",
                limit: 3,
              }),
            },
            {
              prompt: "Use the custom exam notes.",
              call: JSON.stringify({
                mode: "document",
                supplementId: 123,
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["kind", "document"],
                description:
                  'Use "kind" for standard supplement kinds and "document" for custom supplement documents.',
              },
              supplementKind: {
                type: "string",
                enum: [
                  "structure_json",
                  "reading_guide",
                  "chapter_overview",
                  "timeline",
                  "person_map",
                  "concept_index",
                  "summary_standard",
                ],
                description:
                  "Required in kind mode. Must be available in the latest workspace supplement manifest.",
              },
              supplementId: {
                type: "number",
                description:
                  "Preferred identifier for document mode. Must be a custom supplement from the latest manifest.",
              },
              documentTitle: {
                type: "string",
                description:
                  "Exact custom document title fallback for document mode. If multiple documents share the title, use supplementId.",
              },
              query: {
                type: "string",
                description:
                  "Optional logging/future extension field. V1 does not perform retrieval with this value.",
              },
              limit: {
                type: "number",
                minimum: 1,
                maximum: MAX_LIMIT,
                description:
                  "Maximum number of supplement documents to return in kind mode. Capped at 3.",
              },
              reason: {
                type: "string",
                description:
                  "Short reason why this supplement is needed for the answer.",
              },
            },
            required: ["mode"],
            additionalProperties: false,
          },
          handler: async function (args = {}) {
            const callCount = Number(
              this.super._workspaceSupplementToolCalls || 0
            );
            if (callCount >= 1) {
              const result = JSON.stringify({
                ok: false,
                error: "tool_call_limit_exceeded",
                message: TOOL_LIMIT_MESSAGE,
              });
              recordSupplementToolEvent(this.super, {
                ...args,
                returnedCount: 0,
                truncatedCount: 0,
                status: "tool_call_limit_exceeded",
                content: TOOL_LIMIT_MESSAGE,
              });
              return result;
            }
            this.super._workspaceSupplementToolCalls = callCount + 1;

            const workspaceId =
              this.super.handlerProps?.invocation?.workspace_id || null;
            const scopedPrimaryDocumentId =
              primaryDocumentId ||
              this.super.handlerProps?.workspaceSupplementPrimaryDocumentId ||
              null;
            this.super.introspect(
              `${this.caller}: Reading workspace supplement material.`
            );
            const result = await resolveWorkspaceSupplementToolContent({
              workspaceId,
              primaryDocumentId: scopedPrimaryDocumentId,
              mode: args.mode,
              supplementKind: args.supplementKind,
              supplementId: args.supplementId,
              documentTitle: args.documentTitle,
              query: args.query,
              limit: args.limit,
            });
            const parsed = parseResult(result);
            recordSupplementToolEvent(this.super, {
              ...args,
              returnedCount: parsed.returnedCount || 0,
              truncatedCount: parsed.truncatedCount || 0,
              status: parsed.ok ? "success" : parsed.error || "error",
              content:
                parsed.message ||
                `Returned ${parsed.returnedCount || 0} workspace supplement item(s).`,
            });
            return result;
          },
        });
      },
    };
  },
};

module.exports = { workspaceSupplementTool };
