const { UserStatePreference } = require("../models/userStatePreference");
const {
  namespacePolicy,
  userStateNamespaceSummary,
} = require("../utils/dataAccess/dataAccessPolicy");
const {
  sanitizeUserStateValue,
} = require("../utils/userStatePreferencePolicy");

const UserStateRepository = {
  dataDomain: "user-state",
  repositoryName: "UserStateRepository",

  namespacePolicy,

  namespaceSummary() {
    return userStateNamespaceSummary();
  },

  async where(options = {}) {
    return UserStatePreference.where(options);
  },

  async upsertMany({ userId, states = [], syncContext = {} } = {}) {
    const sanitized = states.map((state) => ({
      ...state,
      value: sanitizeUserStateValue(state.namespace, state.value),
      ...(Object.prototype.hasOwnProperty.call(state, "mutationPayload")
        ? {
            mutationPayload: sanitizeUserStateValue(
              state.namespace,
              state.mutationPayload
            ),
          }
        : {}),
    }));
    return UserStatePreference.upsertMany({
      userId,
      states: sanitized,
      syncContext,
    });
  },

  async delete(options = {}) {
    return UserStatePreference.delete(options);
  },
};

module.exports = { UserStateRepository };
