const fs = require("fs");
const path = require("path");
const { canonicalJson, sha256 } = require("../utils/modulePlatform/canonical");
const { loadManifests } = require("../utils/modulePlatform/manifestRegistry");

const OUTPUT = path.resolve(__dirname, "../aicp-schemas/catalog.json");

function kindFor(uri) {
  if (/\/error\//.test(uri)) return "error";
  if (/\/response\//.test(uri)) return "response";
  return "request";
}

const CORE_REQUESTS = Object.freeze({
  "agent.submit": {
    required: ["prompt", "workspaceId"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 1_048_576 },
      workspaceId: { type: "integer", minimum: 1 },
      userId: { type: ["integer", "null"], minimum: 1 },
      threadId: { type: ["integer", "null"], minimum: 1 },
      clientTurnId: { type: ["string", "null"], maxLength: 160 },
      requestedProvider: { type: ["string", "null"], maxLength: 80 },
      requestedModel: { type: ["string", "null"], maxLength: 160 },
      effectiveModel: { type: ["string", "null"], maxLength: 160 },
      turnMode: { type: ["string", "null"], enum: ["normal", "plan", null] },
      goalId: { type: ["string", "null"], maxLength: 160 },
      planId: { type: ["string", "null"], maxLength: 160 },
      planAction: {
        type: ["string", "null"],
        enum: ["create", "revise", "execute", "attach", null],
      },
    },
  },
  "rag.retrieve": {
    required: ["namespace", "input"],
    properties: {
      namespace: { type: "string", minLength: 1, maxLength: 240 },
      input: { type: "string", minLength: 1, maxLength: 1_048_576 },
    },
  },
  "tool.invoke": {
    required: ["approvalRequestId", "toolName"],
    properties: {
      approvalRequestId: { type: "string", minLength: 1, maxLength: 240 },
      toolName: { type: "string", minLength: 1, maxLength: 160 },
      args: { type: "object" },
    },
  },
  "model.stream": {
    required: ["messages"],
    properties: {
      provider: { type: ["string", "null"], maxLength: 80 },
      model: { type: ["string", "null"], maxLength: 160 },
      messages: { type: "array", minItems: 1 },
      options: { type: "object" },
    },
  },
  "model.agent.complete": {
    required: ["messages", "functions"],
    properties: {
      provider: { type: ["string", "null"], maxLength: 80 },
      model: { type: ["string", "null"], maxLength: 160 },
      messages: { type: "array", minItems: 1 },
      functions: { type: "array", maxItems: 256 },
    },
  },
  "model.agent.stream": {
    required: ["messages", "functions"],
    properties: {
      provider: { type: ["string", "null"], maxLength: 80 },
      model: { type: ["string", "null"], maxLength: 160 },
      messages: { type: "array", minItems: 1 },
      functions: { type: "array", maxItems: 256 },
    },
  },
  "model.responses.complete": {
    required: ["provider", "model", "input"],
    properties: {
      provider: { type: "string", minLength: 1, maxLength: 80 },
      model: { type: "string", minLength: 1, maxLength: 160 },
      input: { type: "array" },
      stream: { const: false },
    },
  },
  "model.responses.stream": {
    required: ["provider", "model", "input"],
    properties: {
      provider: { type: "string", minLength: 1, maxLength: 80 },
      model: { type: "string", minLength: 1, maxLength: 160 },
      input: { type: "array" },
      stream: { const: true },
    },
  },
  "responses.create": {
    required: ["provider", "model", "input"],
    properties: {
      provider: { type: "string", minLength: 1, maxLength: 80 },
      model: { type: "string", minLength: 1, maxLength: 160 },
      input: { type: "array" },
    },
  },
  "responses.stream": {
    required: ["provider", "model", "input"],
    properties: {
      provider: { type: "string", minLength: 1, maxLength: 80 },
      model: { type: "string", minLength: 1, maxLength: 160 },
      input: { type: "array" },
    },
  },
});

function schemaFor(uri, contract = null, explicitKind = null) {
  const kind = explicitKind || kindFor(uri);
  const common = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: uri,
    title: uri,
  };
  if (kind === "error")
    return {
      ...common,
      type: "object",
      required: ["success", "error", "reasonCode"],
      properties: {
        success: { const: false },
        error: { type: "string", minLength: 1, maxLength: 160 },
        reasonCode: { type: ["string", "null"], maxLength: 160 },
        retryable: { type: "boolean" },
      },
      additionalProperties: false,
    };
  if (kind === "event")
    return {
      ...common,
      type: "object",
      maxProperties: 256,
      additionalProperties: true,
    };
  const core = kind === "request" ? CORE_REQUESTS[contract?.id] : null;
  if (kind === "response")
    return {
      ...common,
      description: "Capability-scoped AICP business response.",
      type: "object",
      required: ["success"],
      properties: { success: { type: "boolean" } },
      maxProperties: 256,
      additionalProperties: true,
    };
  return {
    ...common,
    description:
      kind === "request"
        ? "Capability-scoped AICP business request. Domain fields remain owned by the provider."
        : "Capability-scoped AICP business response. Domain fields remain owned by the provider.",
    anyOf: [
      {
        type: "object",
        ...(core?.required ? { required: core.required } : {}),
        ...(core?.properties ? { properties: core.properties } : {}),
        maxProperties: 256,
        additionalProperties: true,
      },
      { type: "null" },
    ],
  };
}

function buildCatalog() {
  const schemas = {};
  for (const manifest of loadManifests({ cache: false, refresh: true })) {
    for (const direction of ["provides", "consumes"]) {
      for (const contract of manifest.contracts?.[direction] || []) {
        for (const uri of [contract.requestSchema, contract.responseSchema])
          schemas[uri] ||= schemaFor(uri, contract);
        const errorUri = `athena://contracts/${contract.id}/error/${contract.version}`;
        schemas[errorUri] ||= schemaFor(errorUri, contract);
      }
    }
    for (const direction of ["publishes", "subscribes"])
      for (const contract of manifest.eventContracts?.[direction] || [])
        schemas[contract.payloadSchema] ||= schemaFor(
          contract.payloadSchema,
          contract,
          "event"
        );
  }
  schemas["athena://aicp/stream-frame/1.1"] = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "athena://aicp/stream-frame/1.1",
    type: "object",
    required: [
      "schema",
      "schemaVersion",
      "streamId",
      "sequence",
      "type",
      "payloadHash",
    ],
    properties: {
      schema: { const: "athena.aicp.stream-frame" },
      schemaVersion: { const: "1.1" },
      streamId: { type: "string", minLength: 1 },
      sequence: { type: "integer", minimum: 0 },
      type: {
        enum: ["open", "data", "checkpoint", "heartbeat", "terminal"],
      },
      cursor: { type: ["string", "null"] },
      terminalStatus: {
        type: ["string", "null"],
        enum: ["completed", "failed", "cancelled", null],
      },
      payload: true,
      payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    additionalProperties: false,
  };
  const ordered = Object.fromEntries(
    Object.entries(schemas).sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    schema: "athena.aicp.schema-catalog",
    schemaVersion: "1.1",
    generatedAt: new Date(
      Math.max(0, Number(process.env.SOURCE_DATE_EPOCH || 0)) * 1_000
    ).toISOString(),
    digest: sha256(canonicalJson(ordered)),
    schemas: ordered,
  };
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(buildCatalog(), null, 2)}\n`);
process.stdout.write(`${OUTPUT}\n`);
