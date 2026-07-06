const {
  revokeSensitiveSessions,
  sensitiveSessionSnapshot,
} = require("../utils/authz/sensitiveSessions");
const {
  accessAuditEnvelope,
  assertUserScope,
  DATA_ACCESS_CLASSIFICATIONS,
  fieldClassification,
  sensitiveFieldSummary,
} = require("../utils/dataAccess/dataAccessPolicy");

const SensitiveDataRepository = {
  dataDomain: "sensitive-data",
  repositoryName: "SensitiveDataRepository",

  classify(payload = {}) {
    const fields = sensitiveFieldSummary(payload);
    const classification =
      fields.length > 0
        ? fields.some(
            (field) =>
              field.classification === DATA_ACCESS_CLASSIFICATIONS.secret
          )
          ? DATA_ACCESS_CLASSIFICATIONS.secret
          : DATA_ACCESS_CLASSIFICATIONS.sensitive
        : DATA_ACCESS_CLASSIFICATIONS.internal;
    return {
      classification,
      fields,
      fieldClassification,
      audit: accessAuditEnvelope({
        domain: "sensitiveData",
        operation: "classify",
        payload,
      }),
    };
  },

  sessionSnapshot({ userId = null, clientId = null } = {}) {
    const ownerId = userId
      ? assertUserScope(userId, "sensitiveData.sessionSnapshot")
      : null;
    return sensitiveSessionSnapshot({ userId: ownerId, clientId });
  },

  revokeSessions({ userId, clientId = null, resourceType = null } = {}) {
    const ownerId = assertUserScope(userId, "sensitiveData.revokeSessions");
    return revokeSensitiveSessions({ userId: ownerId, clientId, resourceType });
  },

  snapshot({ userId = null, clientId = null } = {}) {
    return {
      sessions: this.sessionSnapshot({ userId, clientId }),
      classificationPolicy: {
        default: DATA_ACCESS_CLASSIFICATIONS.internal,
        secretPatterns: ["token", "secret", "credential", "authorization"],
      },
    };
  },
};

module.exports = { SensitiveDataRepository };
