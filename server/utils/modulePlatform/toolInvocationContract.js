const ACCOUNT_PRIVATE_APPROVAL_CLASS = "account-private-read";
const ACCOUNT_PRIVATE_RESULT_POLICY = "account-private/summary-only";

function accountPrivateCapabilityManifest(context = {}) {
  return {
    version: 1,
    approvalClass: ACCOUNT_PRIVATE_APPROVAL_CLASS,
    resultPolicy: ACCOUNT_PRIVATE_RESULT_POLICY,
    scopeHash: String(context.scopeHash || ""),
    argumentHash: String(context.argumentHash || ""),
  };
}

function accountPrivateInvocationSubject(context = {}) {
  return `tool-invocation:${String(context.id || "")}`;
}

module.exports = {
  ACCOUNT_PRIVATE_APPROVAL_CLASS,
  ACCOUNT_PRIVATE_RESULT_POLICY,
  accountPrivateCapabilityManifest,
  accountPrivateInvocationSubject,
};
