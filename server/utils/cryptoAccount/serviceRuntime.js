const { DataAccessCenter } = require("../dataAccess");
const { authorizeInvocation } = require("../plugins/capabilityBroker");
const {
  ACCOUNT_PRIVATE_APPROVAL_CLASS,
  accountPrivateCapabilityManifest,
  accountPrivateInvocationSubject,
} = require("../modulePlatform/toolInvocationContract");
const {
  accountCryptoHubRegistry,
  cryptoAccountEligibility,
  resolveApprovedConnection,
} = require(".");

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function symbolValue(value) {
  const symbol = String(value || "")
    .trim()
    .toUpperCase();
  if (!symbol) return null;
  if (!/^[A-Z0-9]{2,20}(?:[_/-][A-Z0-9]{2,12})?$/.test(symbol)) {
    const error = new Error("crypto_account_symbol_invalid");
    error.code = "crypto_account_symbol_invalid";
    error.httpStatus = 400;
    throw error;
  }
  return symbol;
}

async function executeAccountTool(hub, toolName, input = {}) {
  switch (toolName) {
    case "crypto_account_overview":
      return hub.toolOverview();
    case "crypto_account_holdings":
      return hub.holdings({
        symbol: symbolValue(input.symbol),
        limit: boundedInteger(input.limit, 10, 1, 20),
      });
    case "crypto_account_positions":
      return hub.toolOpenPositions({
        symbol: symbolValue(input.symbol),
        limit: boundedInteger(input.limit, 50, 1, 50),
      });
    case "crypto_account_activity":
      return hub.activity({
        symbol: symbolValue(input.symbol),
        days: boundedInteger(input.days, 7, 1, 90),
        limit: boundedInteger(input.limit, 50, 1, 100),
        cursor: input.cursor || null,
      });
    default: {
      const error = new Error("crypto_account_tool_denied");
      error.code = "crypto_account_tool_denied";
      error.httpStatus = 400;
      throw error;
    }
  }
}

async function invokeAccountTool({
  approvalRequestId,
  toolName,
  args = {},
  manifest,
  credential,
} = {}) {
  const context = await DataAccessCenter.toolInvocation.executionContext({
    approvalRequestId,
    toolName,
    args,
    approvalClass: ACCOUNT_PRIVATE_APPROVAL_CLASS,
  });
  const expectedManifest = accountPrivateCapabilityManifest(context);
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    const error = new Error("crypto_account_capability_manifest_mismatch");
    error.code = "crypto_account_capability_manifest_mismatch";
    error.httpStatus = 403;
    throw error;
  }
  const capability = await authorizeInvocation({
    credential,
    serviceIdentity: "crypto-account",
    tool: toolName,
    args,
    manifest: expectedManifest,
    toolInvocationId: context.id,
    requireHybrid: true,
  });
  if (capability.subject !== accountPrivateInvocationSubject(context)) {
    const error = new Error("crypto_account_capability_subject_mismatch");
    error.code = "crypto_account_capability_subject_mismatch";
    error.httpStatus = 403;
    throw error;
  }

  const user = await DataAccessCenter.user.get({
    id: context.ownerUserId,
  });
  if (
    !user ||
    String(user.authUserId || "") !== String(context.ownerAuthUserId || "")
  ) {
    const error = new Error("crypto_account_owner_changed");
    error.code = "crypto_account_owner_changed";
    error.httpStatus = 403;
    throw error;
  }
  const eligibility = await cryptoAccountEligibility(user);
  if (!eligibility.available) {
    const error = new Error(eligibility.reason || "crypto_account_unavailable");
    error.code = eligibility.reason || "crypto_account_unavailable";
    error.httpStatus = 403;
    throw error;
  }
  const resolved = await resolveApprovedConnection({
    user,
    expectedCredentialVersion: eligibility.credentialVersion,
    expectedRootKeyId: eligibility.rootKeyId,
    expectedDomainKeyVersion: eligibility.domainKeyVersion,
  });
  return executeAccountTool(
    accountCryptoHubRegistry.get(resolved),
    toolName,
    args
  );
}

module.exports = {
  executeAccountTool,
  invokeAccountTool,
};
