import { useState, useEffect, useCallback } from "react";
import Admin from "@/models/admin";
import System from "@/models/system";
import AgentPlugins from "@/models/experimental/agentPlugins";
import AgentFlows from "@/models/agentFlows";
import MCPServers from "@/models/mcpServers";
import {
  configurableAgentSkillsFromSettings,
  isDefaultAgentSkillEnabled,
  isSearchModelConfigured,
  WEB_BROWSING_SKILL,
} from "@/pages/Admin/Agents/skills";
import { getSubSkillPreferenceKeys } from "./skillRegistry";
import useSubSkillPreferences from "./useSubSkillPreferences";

/**
 * Core hook for managing all agent skill state.
 * Handles fetching, toggling, and persisting skill preferences.
 */
export default function useAgentSkillsState(defaultSkills) {
  // Core skill state
  const [fileSystemAgentAvailable, setFileSystemAgentAvailable] =
    useState(false);
  const [cryptoAccountAvailable, setCryptoAccountAvailable] = useState(false);
  const [disabledDefaults, setDisabledDefaults] = useState([]);
  const [enabledConfigurable, setEnabledConfigurable] = useState([]);
  const [settings, setSettings] = useState({});
  const [importedSkills, setImportedSkills] = useState([]);
  const [flows, setFlows] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mcpLoading, setMcpLoading] = useState(true);

  // Sub-skill preferences (managed by dedicated hook)
  const subSkillPrefs = useSubSkillPreferences();

  // Fetch all skill settings on mount
  useEffect(() => {
    fetchSkillSettings();
    fetchMcpServers();
  }, []);

  async function fetchSkillSettings() {
    try {
      const subSkillPrefKeys = getSubSkillPreferenceKeys();
      const [
        prefs,
        flowsRes,
        fsAgentAvailable,
        systemSettings,
        cryptoAccountStatus,
      ] = await Promise.all([
        Admin.systemPreferencesByFields([
          "disabled_agent_skills",
          "default_agent_skills",
          "imported_agent_skills",
          ...subSkillPrefKeys,
        ]),
        AgentFlows.listFlows(),
        System.isFileSystemAgentAvailable(),
        System.keys(),
        System.cryptoAccountAgentStatus(),
      ]);

      if (prefs?.settings) {
        setDisabledDefaults(prefs.settings.disabled_agent_skills ?? []);
        setEnabledConfigurable(
          configurableAgentSkillsFromSettings(
            prefs.settings.default_agent_skills ?? []
          )
        );
        setImportedSkills(prefs.settings.imported_agent_skills ?? []);
        subSkillPrefs.loadFromSettings(prefs.settings);
      }
      setSettings(systemSettings || {});
      if (flowsRes?.flows) setFlows(flowsRes.flows);
      setFileSystemAgentAvailable(fsAgentAvailable);
      setCryptoAccountAvailable(cryptoAccountStatus?.available === true);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchMcpServers() {
    try {
      const { servers = [] } = await MCPServers.listServers();
      setMcpServers(servers);
    } catch (e) {
      console.error(e);
    } finally {
      setMcpLoading(false);
    }
  }

  // Skill enabled/disabled checks
  const isSkillEnabled = useCallback(
    (key) => {
      return key in defaultSkills
        ? isDefaultAgentSkillEnabled(key, disabledDefaults, settings)
        : enabledConfigurable.includes(key);
    },
    [defaultSkills, disabledDefaults, enabledConfigurable, settings]
  );

  const isSkillToggleDisabled = useCallback(
    (key) =>
      key === WEB_BROWSING_SKILL &&
      key in defaultSkills &&
      !isSearchModelConfigured(settings),
    [defaultSkills, settings]
  );

  // Toggle functions
  const toggleSkill = useCallback(
    async (key) => {
      if (isSkillToggleDisabled(key)) return;

      const toggleItem = (arr, item) =>
        arr.includes(item) ? arr.filter((s) => s !== item) : [...arr, item];

      if (key in defaultSkills) {
        const updated = toggleItem(disabledDefaults, key);
        setDisabledDefaults(updated);
        await Admin.updateSystemPreferences({
          disabled_agent_skills: updated.join(","),
          default_agent_skills: enabledConfigurable.join(","),
        });
        return;
      }

      const updated = toggleItem(enabledConfigurable, key);
      setEnabledConfigurable(updated);
      await Admin.updateSystemPreferences({
        disabled_agent_skills: disabledDefaults.join(","),
        default_agent_skills: updated.join(","),
      });
    },
    [
      defaultSkills,
      disabledDefaults,
      enabledConfigurable,
      isSkillToggleDisabled,
    ]
  );

  const toggleImportedSkill = useCallback(async (skill) => {
    const newActive = !skill.active;
    setImportedSkills((prev) =>
      prev.map((s) =>
        s.hubId === skill.hubId ? { ...s, active: newActive } : s
      )
    );
    await AgentPlugins.toggleFeature(skill.hubId, newActive);
  }, []);

  const toggleFlow = useCallback(async (flow) => {
    const newActive = !flow.active;
    setFlows((prev) =>
      prev.map((f) => (f.uuid === flow.uuid ? { ...f, active: newActive } : f))
    );
    await AgentFlows.toggleFlow(flow.uuid, newActive);
  }, []);

  const toggleMcpTool = useCallback(
    async (serverName, toolName, currentlyEnabled) => {
      const newEnabled = !currentlyEnabled;
      setMcpServers((prev) => {
        return prev.map((server) => {
          if (server.name !== serverName) return server;
          const currentSuppressed =
            server.config?.anythingllm?.suppressedTools || [];
          const newSuppressed = newEnabled
            ? currentSuppressed.filter((t) => t !== toolName)
            : [...currentSuppressed, toolName];
          return {
            ...server,
            config: {
              ...server.config,
              anythingllm: {
                ...server.config?.anythingllm,
                suppressedTools: newSuppressed,
              },
            },
          };
        });
      });
      await MCPServers.toggleTool(serverName, toolName, newEnabled);
    },
    []
  );

  return {
    // State
    fileSystemAgentAvailable,
    cryptoAccountAvailable,
    disabledDefaults,
    enabledConfigurable,
    importedSkills,
    flows,
    mcpServers,
    loading,
    mcpLoading,

    // Skill checks
    isSkillEnabled,
    isSkillToggleDisabled,

    // Toggle functions
    toggleSkill,
    toggleImportedSkill,
    toggleFlow,
    toggleMcpTool,

    // Sub-skill preferences (delegated)
    isSubSkillEnabled: subSkillPrefs.isSubSkillEnabled,
    toggleSubSkill: subSkillPrefs.toggleSubSkill,
    disabledSubSkills: subSkillPrefs.disabledSubSkills,
  };
}
