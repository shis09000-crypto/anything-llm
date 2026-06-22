import { getJson } from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

const GoogleAgentSkills = {
  gmail: {
    /**
     * Get the current configuration status for Gmail.
     * @returns {Promise<{success: boolean, isConfigured?: boolean, config?: {deploymentId: string, apiKey: string}, error?: string}>}
     */
    getStatus: async () => {
      return await getJson("/admin/agent-skills/gmail/status")
        .then(({ data }) => data)
        .catch((e) => {
          console.error(e);
          return apiErrorFallback(e, { success: false, error: e.message });
        });
    },
  },

  calendar: {
    /**
     * Get the current configuration status for Google Calendar.
     * @returns {Promise<{success: boolean, isConfigured?: boolean, config?: {deploymentId: string, apiKey: string}, error?: string}>}
     */
    getStatus: async () => {
      return await getJson("/admin/agent-skills/google-calendar/status")
        .then(({ data }) => data)
        .catch((e) => {
          console.error(e);
          return apiErrorFallback(e, { success: false, error: e.message });
        });
    },
  },
};

export default GoogleAgentSkills;
