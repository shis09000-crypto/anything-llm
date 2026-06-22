import { getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

const OutlookAgent = {
  /**
   * Save Outlook credentials and get the OAuth authorization URL.
   * @param {Object} credentials - The credentials to save
   * @param {string} credentials.clientId - Application (Client) ID
   * @param {string} credentials.tenantId - Directory (Tenant) ID
   * @param {string} credentials.clientSecret - Client Secret
   * @param {string} credentials.authType - Authentication type (organization, common, consumers)
   * @returns {Promise<{success: boolean, url?: string, error?: string}>}
   */
  saveCredentialsAndGetAuthUrl: async ({
    clientId,
    tenantId,
    clientSecret,
    authType,
  }) => {
    return await postJson("/admin/agent-skills/outlook/auth-url", {
      clientId,
      tenantId,
      clientSecret,
      authType,
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },

  /**
   * Get the current authentication status for Outlook.
   * @returns {Promise<{success: boolean, isConfigured?: boolean, hasCredentials?: boolean, isAuthenticated?: boolean, tokenExpiry?: number, config?: {clientId: string, tenantId: string, clientSecret: string}, error?: string}>}
   */
  getStatus: async () => {
    return await getJson("/admin/agent-skills/outlook/status")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },

  /**
   * Revoke the Outlook authentication tokens.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  revokeAccess: async () => {
    return await postJson("/admin/agent-skills/outlook/revoke")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },
};

export default OutlookAgent;
