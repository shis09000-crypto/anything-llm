const {
  WorkspaceSuggestedMessages,
} = require("../models/workspacesSuggestedMessages");

const WorkspaceSuggestedMessageRepository = {
  get: (...args) => WorkspaceSuggestedMessages.get(...args),
  where: (...args) => WorkspaceSuggestedMessages.where(...args),
  saveAll: (...args) => WorkspaceSuggestedMessages.saveAll(...args),
  getMessages: (...args) => WorkspaceSuggestedMessages.getMessages(...args),
};

module.exports = { WorkspaceSuggestedMessageRepository };
