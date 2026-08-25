const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const SystemSettings = lazyDataAccessFacade("adminSystem");
const AgentPlugins = require("./aibitat/plugins");
const { safeJsonParse } = require("../http");
const { isSearchModelConfigured } = require("../SearchModels/alibaba");
const Provider = require("./aibitat/providers/ai-provider");
const ImportedPlugin = require("./imported");
const { AgentFlows } = require("../agentFlows");
const MCPCompatibilityLayer = require("../MCP");

// This is a list of skills that are built-in and default enabled.
const DEFAULT_SKILLS = [
  AgentPlugins.memory.name,
  AgentPlugins.saveMemory.name,
  AgentPlugins.documentIndexStatusTool.name,
  AgentPlugins.documentIngestAgent.name,
  AgentPlugins.docSummarizer.name,
  AgentPlugins.webScraping.name,
  AgentPlugins.webBrowsing.name,
  AgentPlugins.requestUserInput.name,
  AgentPlugins.cryptoMarketAgent.name,
  AgentPlugins.cryptoAccountAgent.name,
  AgentPlugins.weatherAgent.name,
  AgentPlugins.globalMarketAgent.name,
  AgentPlugins.goldMarketAgent.name,
  AgentPlugins.createFilesAgent.name,
  AgentPlugins.documentFormattingAgent.name,
  AgentPlugins.browserAgent.name,
  AgentPlugins.localRuntimeAgent.name,
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
  "crypto-account-agent": {
    getAvailability: async (user, { registryMode = false } = {}) => {
      if (registryMode) return true;
      if (!user) return false;
      const { cryptoAccountEligibility } = require("../cryptoAccount");
      return (await cryptoAccountEligibility(user)).available;
    },
    disabledSettingKey: null,
  },
  "browser-agent": {
    getAvailability: (_user, { registryMode = false } = {}) =>
      registryMode || process.env.ATHENA_BROWSER_AGENT_ENABLED === "true",
    disabledSettingKey: null,
  },
  "local-runtime-agent": {
    getAvailability: (_user, { registryMode = false } = {}) =>
      registryMode || process.env.ATHENA_LOCAL_RUNTIME_ENABLED === "true",
    disabledSettingKey: null,
  },
};

const SHELL_AGENT_NAME = AgentPlugins.shellAgent.name;
const WEB_BROWSING_NAME = AgentPlugins.webBrowsing.name;
const REQUEST_USER_INPUT_FUNCTION = `${AgentPlugins.requestUserInput.name}#request-user-input`;

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
    let [basePrompt, agentFunctions] = await Promise.all([
      Provider.systemPrompt({
        provider,
        workspace,
        user,
      }),
      agentSkillsFromSystemSettings(user),
    ]);

    if (agentFunctions.includes(REQUEST_USER_INPUT_FUNCTION)) {
      basePrompt +=
        "\n\nWhen you need information from the user (URLs, file paths, preferences, choices, etc.), you MUST use the request-user-input tool. Do not ask questions in your text response - the user cannot reply to text. Only the tool can collect user input. Ask at most 3 questions per turn and keep each question under 150 Unicode characters. For choice questions, provide three guessed options when possible: option 1 is your best recommendation, options 2 and 3 are backups. The user will always have a custom answer input after those options.";
    }

    if (agentFunctions.includes(AgentPlugins.saveMemory.name)) {
      basePrompt +=
        "\n\nWhen the user explicitly asks you to remember, permanently save, write into long-term memory, or keep something for future chats, you MUST call save_memory and wait for the user approval result. save_memory stores account-level long-term memory. Do not use rag-memory.store for account-level preferences, facts, projects, decisions, open topics, interests, or sensitive memories; rag-memory.store is only for this workspace's vector database.";
    }

    return {
      role: basePrompt,
      functions: [
        ...agentFunctions,
        ...sortedDynamicFunctions(ImportedPlugin.activeImportedPlugins()),
        ...sortedDynamicFunctions(AgentFlows.activeFlowPlugins()),
        ...sortedDynamicFunctions(
          await new MCPCompatibilityLayer().activeMCPServers()
        ),
      ],
    };
  },
};

function pushSkillFunctions(
  systemFunctions = [],
  skillName,
  filterState = null
) {
  if (!AgentPlugins.hasOwnProperty(skillName)) return;
  if (skillName === WEB_BROWSING_NAME && !isSearchModelConfigured()) return;

  // This is a plugin module with many sub-children plugins who
  // need to be named via `${parent}#${child}` naming convention.
  if (Array.isArray(AgentPlugins[skillName].plugin)) {
    for (const subPlugin of AgentPlugins[skillName].plugin) {
      if (filterState) {
        if (!filterState.available) continue;
        if (filterState.disabledSubSkills.includes(subPlugin.name)) continue;
      }

      systemFunctions.push(`${AgentPlugins[skillName].name}#${subPlugin.name}`);
    }
    return;
  }

  // This is normal single-stage plugin.
  systemFunctions.push(AgentPlugins[skillName].name);
}

/**
 * Fetches and preloads the names/identifiers for plugins that will be dynamically
 * loaded later
 * @returns {Promise<string[]>}
 */
async function agentSkillsFromSystemSettings(user = null, options = {}) {
  const systemFunctions = [];

  // Load non-imported built-in skills that are configurable, but are default enabled.
  const _disabledDefaultSkills = safeJsonParse(
    await SystemSettings.getValueOrFallback(
      { label: "disabled_agent_skills" },
      "[]"
    ),
    []
  );
  // Load non-imported built-in skills that are configurable.
  const _setting = safeJsonParse(
    await SystemSettings.getValueOrFallback(
      { label: "default_agent_skills" },
      "[]"
    ),
    []
  );

  // Pre-load disabled sub-skills and availability for configured and default
  // skills. This keeps default multi-tool groups subject to their existing
  // dependency checks and per-sub-skill administrator controls.
  const skillFilterState = {};
  for (const skillName of Object.keys(SKILL_FILTER_CONFIG)) {
    if (![...DEFAULT_SKILLS, ..._setting].includes(skillName)) continue;
    const config = SKILL_FILTER_CONFIG[skillName];
    skillFilterState[skillName] = {
      available: await config.getAvailability(user, options),
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

  DEFAULT_SKILLS.forEach((skill) => {
    if (!_disabledDefaultSkills.includes(skill))
      pushSkillFunctions(systemFunctions, skill, skillFilterState[skill]);
  });

  for (const skillName of _setting) {
    if (!AgentPlugins.hasOwnProperty(skillName)) continue;
    if (
      DEFAULT_SKILLS.includes(skillName) &&
      _disabledDefaultSkills.includes(skillName)
    )
      continue;
    pushSkillFunctions(systemFunctions, skillName, skillFilterState[skillName]);
  }
  return uniqueFunctions(systemFunctions);
}

module.exports = {
  USER_AGENT,
  WORKSPACE_AGENT,
  agentSkillsFromSystemSettings,
  functionsForFileAccessPolicy,
  sortedDynamicFunctions,
  SHELL_AGENT_NAME,
};
