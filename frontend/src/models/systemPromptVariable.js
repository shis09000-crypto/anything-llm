import {
  deleteJson,
  getJson,
  postJson,
  putJson,
} from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

/**
 * @typedef {Object} SystemPromptVariable
 * @property {number|null} id - The ID of the system prompt variable
 * @property {string} key - The key of the system prompt variable
 * @property {string} value - The value of the system prompt variable
 * @property {string} description - The description of the system prompt variable
 * @property {string} type - The type of the system prompt variable
 */

const SystemPromptVariable = {
  /**
   * Get all system prompt variables
   * @returns {Promise<{variables: SystemPromptVariable[]}>} - An array of system prompt variables
   */
  getAll: async function () {
    try {
      return await getJson("/system/prompt-variables")
        .then(({ data }) => data)
        .catch((error) => {
          console.error("Error fetching system prompt variables:", error);
          return { variables: [] };
        });
    } catch (error) {
      console.error("Error fetching system prompt variables:", error);
      return { variables: [] };
    }
  },

  /**
   * Create a new system prompt variable
   * @param {SystemPromptVariable} variable - The system prompt variable to create
   * @returns {Promise<{success: boolean, error: string}>} - A promise that resolves to an object containing a success flag and an error message
   */
  create: async function (variable = {}) {
    try {
      return await postJson("/system/prompt-variables", variable)
        .then(({ data }) => data)
        .catch((error) => {
          console.error("Error creating system prompt variable:", error);
          return apiErrorFallback(error, { success: false, error });
        });
    } catch (error) {
      console.error("Error creating system prompt variable:", error);
      return { success: false, error };
    }
  },

  /**
   * Update a system prompt variable
   * @param {string} id - The ID of the system prompt variable to update
   * @param {SystemPromptVariable} variable - The system prompt variable to update
   * @returns {Promise<{success: boolean, error: string}>} - A promise that resolves to an object containing a success flag and an error message
   */
  update: async function (id, variable = {}) {
    try {
      return await putJson(`/system/prompt-variables/${id}`, variable)
        .then(({ data }) => data)
        .catch((error) => {
          console.error("Error updating system prompt variable:", error);
          return apiErrorFallback(error, { success: false, error });
        });
    } catch (error) {
      console.error("Error updating system prompt variable:", error);
      return { success: false, error };
    }
  },

  /**
   * Delete a system prompt variable
   * @param {string} id - The ID of the system prompt variable to delete
   * @returns {Promise<{success: boolean, error: string}>} - A promise that resolves to an object containing a success flag and an error message
   */
  delete: async function (id = null) {
    try {
      if (id === null) return { success: false, error: "ID is required" };
      return await deleteJson(`/system/prompt-variables/${id}`)
        .then(({ data }) => data)
        .catch((error) => {
          console.error("Error deleting system prompt variable:", error);
          return apiErrorFallback(error, { success: false, error });
        });
    } catch (error) {
      console.error("Error deleting system prompt variable:", error);
      return { success: false, error };
    }
  },
};

export default SystemPromptVariable;
