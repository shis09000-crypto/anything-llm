import { postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

const AgentSkillWhitelist = {
  /**
   * Add a skill to the whitelist
   * @param {string} skillName - The skill name to whitelist
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  addToWhitelist: async function (skillName) {
    return postJson("/agent-skills/whitelist/add", { skillName })
      .then(({ data }) => data)
      .catch((e) => apiErrorFallback(e, { success: false, error: e.message }));
  },
};

export default AgentSkillWhitelist;
