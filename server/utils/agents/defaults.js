const AgentPlugins = require("./aibitat/plugins");
const { SystemSettings } = require("../../models/systemSettings");
const { safeJsonParse } = require("../http");
const Provider = require("./aibitat/providers/ai-provider");
const ImportedPlugin = require("./imported");
const { AgentFlows } = require("../agentFlows");
const MCPCompatibilityLayer = require("../MCP");

// This is a list of skills that are built-in and default enabled.
const DEFAULT_SKILLS = [
  AgentPlugins.memory.name,
  AgentPlugins.documentIndexStatusTool.name,
  AgentPlugins.documentIngestAgent.name,
  AgentPlugins.docSummarizer.name,
  AgentPlugins.webScraping.name,
];

/**
 * Configuration for agent skills that require availability checks and disabled sub-skill lists.
 * Each entry maps a skill name to its availability checker and disabled skills list key.
 */
const SKILL_FILTER_CONFIG = {
  "filesystem-agent": {
    getAvailability: () =>
      require("./aibitat/plugins/filesystem/lib").isToolAvailable(),
    disabledSettingKey: "disabled_filesystem_skills",
  },
  "create-files-agent": {
    getAvailability: () =>
      require("./aibitat/plugins/create-files/lib").isToolAvailable(),
    disabledSettingKey: "disabled_create_files_skills",
  },
  "gmail-agent": {
    getAvailability: async () =>
      require("./aibitat/plugins/gmail/lib").GmailBridge.isToolAvailable(),
    disabledSettingKey: "disabled_gmail_skills",
  },
  "outlook-agent": {
    getAvailability: async () =>
      require("./aibitat/plugins/outlook/lib").OutlookBridge.isToolAvailable(),
    disabledSettingKey: "disabled_outlook_skills",
  },
  "shell-agent": {
    getAvailability: () => true,
    disabledSettingKey: null,
  },
};

const SHELL_AGENT_NAME = AgentPlugins.shellAgent.name;

function uniqueFunctions(functions = []) {
  return [...new Set((functions || []).filter(Boolean))];
}

function sortedDynamicFunctions(functions = []) {
  return uniqueFunctions(functions).sort((a, b) =>
    String(a).localeCompare(String(b))
  );
}

function functionsForFileAccessPolicy(functions = [], fileAccessPolicy = {}) {
  const nextFunctions = uniqueFunctions(functions);
  if (fileAccessPolicy?.mode === "open") {
    if (!nextFunctions.includes(SHELL_AGENT_NAME))
      nextFunctions.push(SHELL_AGENT_NAME);
    return nextFunctions;
  }

  return nextFunctions.filter((name) => name !== SHELL_AGENT_NAME);
}

const USER_AGENT = {
  name: "USER",
  getDefinition: () => {
    return {
      interrupt: "ALWAYS",
      role: "I am the human monitor and oversee this chat. Any questions on action or decision making should be directed to me.",
    };
  },
};

const WORKSPACE_AGENT = {
  name: "@agent",
  /**
   * Get the definition for the workspace agent with its role (prompt) and functions in Aibitat format
   * @param {string} provider
   * @param {import("@prisma/client").workspaces | null} workspace
   * @param {import("@prisma/client").users | null} user
   * @returns {Promise<{ role: string, functions: object[] }>}
   */
  getDefinition: async (provider = null, workspace = null, user = null) => {
    let [basePrompt, clarifyingQuestionsSkills] = await Promise.all([
      Provider.systemPrompt({
        provider,
        workspace,
        user,
      }),
      clarifyingQuestionsSkillIfEnabled(),
    ]);

    if (clarifyingQuestionsSkills.length > 0) {
      basePrompt +=
        "\n\nWhen you need information from the user (URLs, file paths, preferences, choices, etc.), you MUST use the request-user-input tool. Do not ask questions in your text response - the user cannot reply to text. Only the tool can collect user input. Ask at most 3 questions per turn and keep each question under 150 characters. For choice questions, provide three guessed options when possible: option 1 is your best recommendation, options 2 and 3 are backups. The user will always have a custom answer input after those options.";
    }

    return {
      role: basePrompt,
      functions: [
        ...(await agentSkillsFromSystemSettings()),
        ...clarifyingQuestionsSkills,
        ...sortedDynamicFunctions(ImportedPlugin.activeImportedPlugins()),
        ...sortedDynamicFunctions(AgentFlows.activeFlowPlugins()),
        ...sortedDynamicFunctions(
          await new MCPCompatibilityLayer().activeMCPServers()
        ),
      ],
    };
  },
};

/**
 * Conditionally include the request-user-input sub-tools in the workspace
 * agent's function list when the admin has enabled clarifying questions.
 * @returns {Promise<string[]>}
 */
async function clarifyingQuestionsSkillIfEnabled() {
  const enabled =
    (await SystemSettings.getValueOrFallback(
      { label: "agent_clarifying_questions_enabled" },
      "false"
    )) === "true";
  if (!enabled) return [];

  const parentName = AgentPlugins.requestUserInput.name;
  const subPlugins = AgentPlugins.requestUserInput.plugin;
  if (!Array.isArray(subPlugins)) return [];
  return subPlugins.map((sub) => `${parentName}#${sub.name}`);
}

/**
 * Fetches and preloads the names/identifiers for plugins that will be dynamically
 * loaded later
 * @returns {Promise<string[]>}
 */
async function agentSkillsFromSystemSettings() {
  const systemFunctions = [];

  // Load non-imported built-in skills that are configurable, but are default enabled.
  const _disabledDefaultSkills = safeJsonParse(
    await SystemSettings.getValueOrFallback(
      { label: "disabled_agent_skills" },
      "[]"
    ),
    []
  );
  DEFAULT_SKILLS.forEach((skill) => {
    if (!_disabledDefaultSkills.includes(skill))
      systemFunctions.push(AgentPlugins[skill].name);
  });

  // Load non-imported built-in skills that are configurable.
  const _setting = safeJsonParse(
    await SystemSettings.getValueOrFallback(
      { label: "default_agent_skills" },
      "[]"
    ),
    []
  );

  // Pre-load disabled sub-skills and availability for configured skills
  const skillFilterState = {};
  for (const skillName of Object.keys(SKILL_FILTER_CONFIG)) {
    if (!_setting.includes(skillName)) continue;
    const config = SKILL_FILTER_CONFIG[skillName];
    skillFilterState[skillName] = {
      available: await config.getAvailability(),
      disabledSubSkills: config.disabledSettingKey
        ? safeJsonParse(
            await SystemSettings.getValueOrFallback(
              { label: config.disabledSettingKey },
              "[]"
            ),
            []
          )
        : [],
    };
  }

  for (const skillName of _setting) {
    if (!AgentPlugins.hasOwnProperty(skillName)) continue;

    // This is a plugin module with many sub-children plugins who
    // need to be named via `${parent}#${child}` naming convention
    if (Array.isArray(AgentPlugins[skillName].plugin)) {
      for (const subPlugin of AgentPlugins[skillName].plugin) {
        // Check if this skill has filter configuration
        const filterState = skillFilterState[skillName];
        if (filterState) {
          if (!filterState.available) continue;
          if (filterState.disabledSubSkills.includes(subPlugin.name)) continue;
        }

        systemFunctions.push(
          `${AgentPlugins[skillName].name}#${subPlugin.name}`
        );
      }
      continue;
    }

    // This is normal single-stage plugin
    systemFunctions.push(AgentPlugins[skillName].name);
  }
  return systemFunctions;
}

module.exports = {
  USER_AGENT,
  WORKSPACE_AGENT,
  agentSkillsFromSystemSettings,
  functionsForFileAccessPolicy,
  sortedDynamicFunctions,
  SHELL_AGENT_NAME,
};
