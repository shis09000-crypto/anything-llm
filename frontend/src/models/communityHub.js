import { getJson, postJson } from "@/lib/communication/apiClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
} from "@/lib/communication/apiError";

const CommunityHub = {
  /**
   * Get an item from the community hub by its import ID.
   * @param {string} importId - The import ID of the item.
   * @returns {Promise<{error: string | null, item: object | null}>}
   */
  getItemFromImportId: async (importId) => {
    return await postJson("/community-hub/item", { importId })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          error: e.message,
          item: null,
        });
      });
  },

  /**
   * Apply an item to the Athena instance. Used for simple items like slash commands and system prompts.
   * @param {string} importId - The import ID of the item.
   * @param {object} options - Additional options for applying the item for whatever the item type requires.
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  applyItem: async (importId, options = {}) => {
    return await postJson("/community-hub/apply", { importId, options })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: e.message,
        });
      });
  },

  /**
   * Import a bundle item from the community hub.
   * @param {string} importId - The import ID of the item.
   * @returns {Promise<{error: string | null, item: object | null}>}
   */
  importBundleItem: async (importId) => {
    return await postJson("/community-hub/import", { importId })
      .then(({ data }) => data)
      .catch((e) => {
        return {
          error: responseError(e, "Failed to import bundle item"),
          item: null,
        };
      });
  },

  /**
   * Update the hub settings (API key, etc.)
   * @param {Object} data - The data to update.
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  updateSettings: async (data) => {
    return await postJson("/community-hub/settings", data)
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => ({
        success: false,
        error: responseError(e, "Failed to update settings"),
      }));
  },

  /**
   * Get the hub settings (API key, etc.)
   * @returns {Promise<{connectionKey: string | null, error: string | null}>}
   */
  getSettings: async () => {
    return await getJson("/community-hub/settings")
      .then(({ data: response }) => {
        return { connectionKey: response.connectionKey, error: null };
      })
      .catch((e) => ({
        connectionKey: null,
        error: responseError(e, "Failed to fetch settings"),
      }));
  },

  /**
   * Fetch the explore items from the community hub that are publicly available.
   * @returns {Promise<{agentSkills: {items: [], hasMore: boolean, totalCount: number}, systemPrompts: {items: [], hasMore: boolean, totalCount: number}, slashCommands: {items: [], hasMore: boolean, totalCount: number}}>}
   */
  fetchExploreItems: async () => {
    return await getJson("/community-hub/explore")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: e.message,
          result: null,
        });
      });
  },

  /**
   * Fetch the user items from the community hub.
   * @returns {Promise<{success: boolean, error: string | null, createdByMe: object, teamItems: object[]}>}
   */
  fetchUserItems: async () => {
    return await getJson("/community-hub/items")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: e.message,
          createdByMe: {},
          teamItems: [],
        });
      });
  },

  /**
   * Create a new system prompt in the community hub
   * @param {Object} data - The system prompt data
   * @param {string} data.name - The name of the prompt
   * @param {string} data.description - The description of the prompt
   * @param {string} data.prompt - The actual system prompt text
   * @param {string[]} data.tags - Array of tags
   * @param {string} data.visibility - Either 'public' or 'private'
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  createSystemPrompt: async (data) => {
    return await postJson("/community-hub/system-prompt/create", data)
      .then(({ data: response }) => {
        return { success: true, error: null, itemId: response.item?.id };
      })
      .catch((e) => ({
        success: false,
        error: responseError(e, "Failed to create system prompt"),
      }));
  },

  /**
   * Create a new agent flow in the community hub
   * @param {Object} data - The agent flow data
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  createAgentFlow: async (data) => {
    return await postJson("/community-hub/agent-flow/create", data)
      .then(({ data: response }) => ({
        success: true,
        error: null,
        itemId: response.item?.id,
      }))
      .catch((e) => {
        throw new Error(responseError(e, "Failed to create agent flow"));
      });
  },

  /**
   * Create a new slash command in the community hub
   * @param {Object} data - The slash command data
   * @param {string} data.name - The name of the command
   * @param {string} data.description - The description of the command
   * @param {string} data.command - The actual command text
   * @param {string} data.prompt - The prompt for the command
   * @param {string[]} data.tags - Array of tags
   * @param {string} data.visibility - Either 'public' or 'private'
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  createSlashCommand: async (data) => {
    return await postJson("/community-hub/slash-command/create", data)
      .then(({ data: response }) => {
        return { success: true, error: null, itemId: response.item?.id };
      })
      .catch((e) => ({
        success: false,
        error: responseError(e, "Failed to create slash command"),
      }));
  },
};

export default CommunityHub;
