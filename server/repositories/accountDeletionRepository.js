const prisma = require("../utils/prisma");
const { AuthIdentity } = require("../models/authIdentity");
const { Workspace } = require("../models/workspace");
const { WorkspaceChats } = require("../models/workspaceChats");

const AccountDeletionRepository = {
  dataDomain: "account-deletion",
  repositoryName: "AccountDeletionRepository",

  get authIdentity() {
    return AuthIdentity;
  },

  get workspace() {
    return Workspace;
  },

  get workspaceChats() {
    return WorkspaceChats;
  },

  get db() {
    return {
      get browser_extension_api_keys() {
        return prisma.browser_extension_api_keys;
      },
      get desktop_mobile_devices() {
        return prisma.desktop_mobile_devices;
      },
      get documentIndexStatus() {
        return prisma.documentIndexStatus;
      },
      get prompt_history() {
        return prisma.prompt_history;
      },
      get system_prompt_variables() {
        return prisma.system_prompt_variables;
      },
      get temporary_auth_tokens() {
        return prisma.temporary_auth_tokens;
      },
      get users() {
        return prisma.users;
      },
      get workspace_agent_invocations() {
        return prisma.workspace_agent_invocations;
      },
      get workspace_chat_compactions() {
        return prisma.workspace_chat_compactions;
      },
      get workspace_chats() {
        return prisma.workspace_chats;
      },
      get workspace_documents() {
        return prisma.workspace_documents;
      },
      get workspace_mind_maps() {
        return prisma.workspace_mind_maps;
      },
      get workspace_parsed_files() {
        return prisma.workspace_parsed_files;
      },
      get workspace_quiz_attempts() {
        return prisma.workspace_quiz_attempts;
      },
      get workspace_quiz_favorite_questions() {
        return prisma.workspace_quiz_favorite_questions;
      },
      get workspace_quiz_wrong_questions() {
        return prisma.workspace_quiz_wrong_questions;
      },
      get workspace_threads() {
        return prisma.workspace_threads;
      },
      get workspace_users() {
        return prisma.workspace_users;
      },
    };
  },
};

module.exports = { AccountDeletionRepository };
