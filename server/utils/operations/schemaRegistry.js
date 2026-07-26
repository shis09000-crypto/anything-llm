const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const entries = new Map();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(schema) {
  return crypto.createHash("sha256").update(canonical(schema)).digest("hex");
}

function registryKey(name, version) {
  return `${String(name)}@${String(version)}`;
}

const TOP_LEVEL_FIELDS = new Set([
  "schema",
  "schemaVersion",
  "eventId",
  "eventType",
  "category",
  "severity",
  "outcome",
  "occurredAt",
  "observedAt",
  "producer",
  "subject",
  "actor",
  "correlation",
  "stateTransition",
  "impact",
  "metadata",
  "evidence",
  "hypotheses",
  "recommendation",
  "sensitivity",
  "retentionClass",
]);

const OBJECT_FIELDS = Object.freeze({
  producer: new Set(["service", "version", "runtimeRole"]),
  subject: new Set(["type", "id", "component", "operation"]),
  actor: new Set(["type", "id"]),
  correlation: new Set([
    "operationId",
    "interactionId",
    "requestId",
    "traceId",
    "spanId",
    "sourceActionId",
    "clientTurnId",
    "invocationId",
    "toolCallId",
    "clientId",
  ]),
  stateTransition: new Set(["from", "to", "reasonCode"]),
  impact: new Set(["userEffect", "slo", "scope", "status"]),
  metadata: new Set([
    "errorCode",
    "statusCode",
    "durationMs",
    "provider",
    "model",
    "backend",
  ]),
  recommendation: new Set(["actionId", "risk", "permission"]),
});

function validateObject(value, label, allowedFields, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`invalid:${label}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) errors.push(`unknown:${label}.${key}`);
    else if (typeof value[key] !== "string")
      errors.push(`invalid:${label}.${key}`);
  }
}

function validateSemanticEventV1(value = {}) {
  const missing = [
    "schema",
    "schemaVersion",
    "eventId",
    "eventType",
    "category",
    "severity",
    "outcome",
    "occurredAt",
    "producer",
    "correlation",
    "sensitivity",
    "retentionClass",
  ].filter((key) => value[key] === undefined || value[key] === null);
  const errors = missing.map((key) => `missing:${key}`);
  for (const key of Object.keys(value))
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`unknown:${key}`);
  if (value.schema !== "athena.ops.event") errors.push("invalid:schema");
  if (value.schemaVersion !== "1.0") errors.push("invalid:schemaVersion");
  if (
    !["debug", "info", "warning", "error", "critical"].includes(value.severity)
  )
    errors.push("invalid:severity");
  if (!Number.isFinite(Date.parse(value.occurredAt)))
    errors.push("invalid:occurredAt");
  if (value.observedAt && !Number.isFinite(Date.parse(value.observedAt)))
    errors.push("invalid:observedAt");
  for (const field of [
    "eventId",
    "eventType",
    "category",
    "outcome",
    "sensitivity",
    "retentionClass",
  ]) {
    if (typeof value[field] !== "string" || !value[field])
      errors.push(`invalid:${field}`);
  }
  for (const [field, allowed] of Object.entries(OBJECT_FIELDS)) {
    if (field === "producer" || value[field] !== undefined)
      validateObject(value[field], field, allowed, errors);
  }
  for (const field of ["service", "version", "runtimeRole"])
    if (!value.producer?.[field]) errors.push(`missing:producer.${field}`);
  if (!Array.isArray(value.evidence) || value.evidence.length > 12)
    errors.push("invalid:evidence");
  else
    value.evidence.forEach((item, index) =>
      validateObject(
        item,
        `evidence.${index}`,
        new Set(["type", "ref", "metric", "comparison"]),
        errors
      )
    );
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length > 8)
    errors.push("invalid:hypotheses");
  else
    value.hypotheses.forEach((item, index) => {
      const label = `hypotheses.${index}`;
      const allowed = new Set([
        "reason",
        "component",
        "confidence",
        "counterEvidence",
      ]);
      if (!item || typeof item !== "object" || Array.isArray(item))
        errors.push(`invalid:${label}`);
      else
        for (const key of Object.keys(item))
          if (!allowed.has(key)) errors.push(`unknown:${label}.${key}`);
      if (!item?.reason || !Number.isFinite(item?.confidence))
        errors.push(`invalid:${label}`);
      if (
        !Array.isArray(item?.counterEvidence) ||
        item.counterEvidence.length > 6 ||
        item.counterEvidence.some((entry) => typeof entry !== "string")
      )
        errors.push(`invalid:${label}.counterEvidence`);
    });
  return { valid: errors.length === 0, errors };
}

function registerSchema({ name, version, schema, validate }) {
  const key = registryKey(name, version);
  if (entries.has(key)) throw new Error(`schema_already_registered:${key}`);
  const entry = Object.freeze({
    name,
    version,
    schema,
    fingerprint: fingerprint(schema),
    validate,
  });
  entries.set(key, entry);
  return entry;
}

function getSchema(name, version) {
  return entries.get(registryKey(name, version)) || null;
}

function validateRegistered(value = {}) {
  const entry = getSchema(value.schema, value.schemaVersion);
  if (!entry)
    return {
      valid: false,
      errors: [
        `unknown_schema:${registryKey(value.schema, value.schemaVersion)}`,
      ],
    };
  return entry.validate(value);
}

function schemaManifest() {
  return [...entries.values()].map(({ name, version, fingerprint }) => ({
    name,
    version,
    fingerprint,
  }));
}

const semanticEventSchema = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../observability/semantic-event-v1.schema.json"),
    "utf8"
  )
);
registerSchema({
  name: "athena.ops.event",
  version: "1.0",
  schema: semanticEventSchema,
  validate: validateSemanticEventV1,
});

module.exports = {
  fingerprint,
  getSchema,
  registerSchema,
  schemaManifest,
  validateRegistered,
};
