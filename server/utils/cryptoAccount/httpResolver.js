const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const User = lazyDataAccessFacade("user");
const { accountCryptoHubRegistry } = require("./accountHub");
const {
  cryptoAccountEligibility,
  resolveApprovedConnection,
} = require("./connectionService");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");

async function hasUniquePrimaryOwner() {
  const owners = await User.where(
    { status: "active", ownerType: "primary" },
    2,
    { id: "asc" }
  );
  return owners.length === 1 && Boolean(owners[0]?.authUserId);
}

function legacyFallbackAllowed(user) {
  return (
    process.env.ATHENA_CRYPTO_LEGACY_FALLBACK !== "false" &&
    process.env.GATE_API_READONLY === "true" &&
    Boolean(user)
  );
}

function emitLegacyFallback() {
  metrics.cryptoAccountReads.inc({
    function: "legacy_fallback",
    outcome: "fallback",
  });
  emitSemanticEvent({
    eventType: "crypto.account.legacy_fallback",
    category: "crypto-account-access",
    severity: "warning",
    outcome: "fallback",
    subject: {
      type: "component",
      component: "crypto-account-access",
      operation: "legacy-readonly-fallback",
    },
    sensitivity: "metadata_only",
  });
}

async function resolveCryptoHubForHttp(user) {
  const eligibility = await cryptoAccountEligibility(user);
  if (eligibility.available) {
    const resolved = await resolveApprovedConnection({
      user,
      expectedCredentialVersion: eligibility.credentialVersion,
      expectedRootKeyId: eligibility.rootKeyId,
      expectedDomainKeyVersion: eligibility.domainKeyVersion,
    });
    return {
      hub: accountCryptoHubRegistry.get(resolved),
      mode: "account",
    };
  }
  if (legacyFallbackAllowed(user) && (await hasUniquePrimaryOwner())) {
    emitLegacyFallback();
    const { cryptoDataHub } = require("../cryptoHub");
    return { hub: cryptoDataHub, mode: "legacy-primary-owner" };
  }
  const error = new Error(eligibility.reason || "crypto_account_unavailable");
  error.code = eligibility.reason || "crypto_account_unavailable";
  throw error;
}

module.exports = {
  resolveCryptoHubForHttp,
};
