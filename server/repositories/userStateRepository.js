const { UserStatePreference } = require("../models/userStatePreference");
const {
  namespacePolicy,
  sanitizeValue,
  userStateNamespaceSummary,
} = require("../utils/dataAccess/dataAccessPolicy");

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

  async upsertMany({ userId, states = [] } = {}) {
    const sanitized = states.map((state) => ({
      ...state,
      value: sanitizeValue(state.value),
    }));
    return UserStatePreference.upsertMany({
      userId,
      states: sanitized,
    });
  },

  async delete(options = {}) {
    return UserStatePreference.delete(options);
  },
};

module.exports = { UserStateRepository };
