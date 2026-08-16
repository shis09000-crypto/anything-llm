const { AicpContractRegistry } = require("./contractRegistry");
const { createAicpContext, payloadHash } = require("./context");
const { aicpSchemaRegistry } = require("./schemaRegistry");

async function invokeLocalCapability({
  callerModule,
  targetModule,
  capability,
  body = null,
  idempotencyKey = null,
  coordinationContext = null,
  principalAssertion = null,
  approvalId = null,
  signal = null,
  handler,
} = {}) {
  if (typeof handler !== "function") {
    const error = new Error("aicp_local_handler_missing");
    error.code = "AICP_LOCAL_HANDLER_MISSING";
    throw error;
  }
  const negotiation = new AicpContractRegistry().negotiate({
    callerModule,
    targetModule,
    capability,
    protocolVersion: "1.1",
  });
  if (negotiation.idempotency === "required" && !idempotencyKey) {
    const error = new Error("aicp_idempotency_key_required");
    error.code = "AICP_IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const requestValidation = aicpSchemaRegistry().validate(
    negotiation.requestSchema,
    body
  );
  if (!requestValidation.valid) {
    const error = new Error("aicp_request_schema_invalid");
    error.code = "AICP_REQUEST_SCHEMA_INVALID";
    error.findings = requestValidation.findings;
    throw error;
  }
  const context = createAicpContext({
    negotiation,
    payload: body,
    method: "LOCAL",
    path: `local://${targetModule}/${capability}`,
    idempotencyKey,
    coordinationContext,
    principalAssertion,
    approvalId,
  });
  if (signal?.aborted) {
    const error = new Error("aicp_local_call_aborted");
    error.code = "AICP_LOCAL_CALL_ABORTED";
    throw error;
  }
  const result = await handler(body, { context, signal });
  const responseValidation = aicpSchemaRegistry().validate(
    negotiation.responseSchema,
    result
  );
  if (!responseValidation.valid) {
    const error = new Error("aicp_response_schema_invalid");
    error.code = "AICP_RESPONSE_SCHEMA_INVALID";
    error.findings = responseValidation.findings;
    throw error;
  }
  return {
    result,
    metadata: {
      capability: negotiation.capability,
      version: negotiation.version,
      resultHash: payloadHash(result),
      status: "completed",
    },
  };
}

module.exports = { invokeLocalCapability };
