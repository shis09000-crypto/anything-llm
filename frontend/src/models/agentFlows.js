import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import {
  apiErrorFallback,
  apiErrorMessage,
} from "@/lib/communication/apiError";

const AgentFlows = {
  /**
   * Save a flow configuration
   * @param {string} name - Display name of the flow
   * @param {object} config - The configuration object for the flow
   * @param {string} [uuid] - Optional UUID for updating existing flow
   * @returns {Promise<{success: boolean, error: string | null, flow: {name: string, config: object, uuid: string} | null}>}
   */
  saveFlow: async (name, config, uuid = null) => {
    return await postJson("/agent-flows/save", { name, config, uuid })
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: apiErrorMessage(e, "Failed to save flow"),
        flow: null,
      }));
  },

  /**
   * List all available flows in the system
   * @returns {Promise<{success: boolean, error: string | null, flows: Array<{name: string, uuid: string, description: string, steps: Array}>}>}
   */
  listFlows: async () => {
    return await getJson("/agent-flows/list")
      .then(({ data }) => data)
      .catch((e) =>
        apiErrorFallback(e, {
          success: false,
          error: e.message,
          flows: [],
        })
      );
  },

  /**
   * Get a specific flow by UUID
   * @param {string} uuid - The UUID of the flow to retrieve
   * @returns {Promise<{success: boolean, error: string | null, flow: {name: string, config: object, uuid: string} | null}>}
   */
  getFlow: async (uuid) => {
    return await getJson(`/agent-flows/${uuid}`)
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: apiErrorMessage(e, "Failed to get flow"),
        flow: null,
      }));
  },

  /**
   * Delete a specific flow
   * @param {string} uuid - The UUID of the flow to delete
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  deleteFlow: async (uuid) => {
    return await deleteJson(`/agent-flows/${uuid}`)
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: apiErrorMessage(e, "Failed to delete flow"),
      }));
  },

  /**
   * Toggle a flow's active status
   * @param {string} uuid - The UUID of the flow to toggle
   * @param {boolean} active - The new active status
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  toggleFlow: async (uuid, active) => {
    try {
      const { data: result } = await postJson(`/agent-flows/${uuid}/toggle`, {
        active,
      });
      return { success: true, flow: result.flow };
    } catch (error) {
      console.error("Failed to toggle flow:", error);
      return {
        success: false,
        error: apiErrorMessage(error, "Failed to toggle flow"),
      };
    }
  },
};

export default AgentFlows;
