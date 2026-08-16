const eventEnvelope = require("./eventEnvelope");
const {
  loadManifests,
  manifestSnapshot,
  moduleManifest,
  validateManifest,
} = require("./manifestRegistry");
const {
  issuePrincipalAssertion,
  verifyPrincipalAssertion,
} = require("./principalAssertion");
const toolInvocationContract = require("./toolInvocationContract");
const aicp = require("./aicp");

module.exports = {
  aicp,
  ...eventEnvelope,
  issuePrincipalAssertion,
  loadManifests,
  manifestSnapshot,
  moduleManifest,
  validateManifest,
  verifyPrincipalAssertion,
  ...toolInvocationContract,
};
