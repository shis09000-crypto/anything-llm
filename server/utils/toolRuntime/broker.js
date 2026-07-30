const { DataAccessCenter } = require("../dataAccess");
const { requestInternalService } = require("../microModules/internalClient");
const { issueInvocationCredential } = require("../plugins/capabilityBroker");
const {
  ACCOUNT_PRIVATE_APPROVAL_CLASS,
  accountPrivateCapabilityManifest,
  accountPrivateInvocationSubject,
} = require("../modulePlatform/toolInvocationContract");

const CRYPTO_ACCOUNT_TOOLS = new Set([
  "crypto_account_overview",
  "crypto_account_holdings",
  "crypto_account_positions",
  "crypto_account_activity",
]);

function normalizedBaseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, "");
}

function cryptoAccountServiceUrl(env = process.env) {
  return normalizedBaseUrl(
    env.ATHENA_CRYPTO_ACCOUNT_URL,
    "https://crypto-account:3021"
  );
}

async function dispatchCryptoAccount({
  approvalRequestId,
  toolName,
  args = {},
  env = process.env,
} = {}) {
  const tool = String(toolName || "").trim();
  if (!CRYPTO_ACCOUNT_TOOLS.has(tool)) {
    const error = new Error("tool_broker_crypto_account_tool_denied");
    error.code = "tool_broker_crypto_account_tool_denied";
    error.httpStatus = 400;
    throw error;
  }
  const context = await DataAccessCenter.toolInvocation.executionContext({
    approvalRequestId,
    toolName: tool,
    args,
    approvalClass: ACCOUNT_PRIVATE_APPROVAL_CLASS,
  });
  const manifest = accountPrivateCapabilityManifest(context);
  const credential = issueInvocationCredential({
    serviceIdentity: "crypto-account",
    tool,
    args,
    manifest,
    subject: accountPrivateInvocationSubject(context),
    requireHybrid: true,
    env,
  });
  const response = await requestInternalService({
    callerRole: "tool-broker",
    url: `${cryptoAccountServiceUrl(env)}/internal/v1/crypto/account/read`,
    body: {
      approvalRequestId: context.approvalRequestId,
      toolName: tool,
      args,
      manifest,
      credential,
    },
    idempotencyKey: context.id,
    env,
    timeoutMs: Number(env.ATHENA_TOOL_INVOCATION_TIMEOUT_MS || 120_000),
  });
  return response.result;
}

module.exports = {
  CRYPTO_ACCOUNT_TOOLS,
  cryptoAccountServiceUrl,
  dispatchCryptoAccount,
};
