const { requestInternalService } = require("../microModules");
const {
  executionMetadata,
  unknownExecutionMetadata,
} = require("../chats/executionMetadata");

function parseResponse(record) {
  try {
    return JSON.parse(record.response || "{}");
  } catch {
    return null;
  }
}

async function enrichChatExecutionMetadata(
  history = [],
  { userId = null, workspaceId = null, threadId = undefined } = {}
) {
  const pending = history
    .map((record) => ({ record, data: parseResponse(record) }))
    .filter(
      ({ record, data }) =>
        data && !data.execution && !data.metrics?.model && record.clientTurnId
    )
    .slice(0, 100);
  if (pending.length === 0) return history;
  let items = [];
  try {
    const baseUrl = String(
      process.env.ATHENA_RESPONSES_RUNTIME_URL || ""
    ).replace(/\/+$/, "");
    if (!baseUrl) throw new Error("responses_runtime_url_missing");
    const resolved = await requestInternalService({
      callerRole: "athena-api",
      targetModule: "responses-runtime",
      capability: "responses.execution-metadata.resolve",
      contractVersion: "1.0",
      url: `${baseUrl}/internal/v1/responses/execution-metadata/resolve`,
      body: {
        ownerUserId: userId,
        workspaceId,
        ...(threadId !== undefined ? { threadId } : {}),
        references: pending.map(({ record }) => ({
          chatRunId: record.clientTurnId,
        })),
      },
      timeoutMs: 5_000,
    });
    items = resolved.items || [];
  } catch {
    items = [];
  }
  const byRun = new Map(
    items.map((item) => [item.chatRunId || item.agentRunId, item])
  );
  return history.map((record) => {
    const data = parseResponse(record);
    if (!data || data.execution) return record;
    const resolved = byRun.get(record.clientTurnId);
    data.execution = resolved
      ? executionMetadata({
          model: resolved.model,
          provider: resolved.provider,
          requestedProtocol: resolved.requestedProtocol,
          effectiveProtocol: resolved.effectiveProtocol,
          responseId: resolved.id,
          source: "responses_runtime",
        })
      : unknownExecutionMetadata();
    return { ...record, response: JSON.stringify(data) };
  });
}

module.exports = { enrichChatExecutionMetadata };
