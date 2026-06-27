import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
  apiErrorRaw as rawBody,
} from "@/lib/communication/apiError";

function responseJsonError(error) {
  const data = rawBody(error) || {};
  return {
    success: false,
    error: data?.error || data?.message || error.message,
    ...data,
  };
}

function withQuery(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    query.set(key, String(value));
  });
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

const Admin = {
  // User Management
  usersPage: async ({ limit = 50, offset = 0 } = {}) => {
    return await getJson(withQuery("/admin/users", { limit, offset }))
      .then(({ data }) => ({ users: data?.users || [], page: data?.page }))
      .catch((e) => {
        console.error(e);
        return { users: [], page: null };
      });
  },
  users: async () => {
    return await getJson("/admin/users")
      .then(({ data }) => data?.users || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  newUser: async (data) => {
    return await postJson("/admin/users/new", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { user: null, error: e.message });
      });
  },
  updateUser: async (userId, data) => {
    return await postJson(`/admin/user/${userId}`, data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteUser: async (userId) => {
    return await Admin.deleteUserWithReauth(userId, {});
  },
  userDeletePreview: async (userId) => {
    return await getJson(`/admin/users/${userId}/delete-preview`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },
  deleteUserWithReauth: async (
    userId,
    { confirm = false, reauthToken } = {}
  ) => {
    return await deleteJson(`/admin/user/${userId}`, {
      body: { confirm, reauthToken },
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },
  banUser: async (userId, reason = "") => {
    return await postJson(`/admin/users/${userId}/ban`, { reason })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },
  unbanUser: async (userId, { restoreRole, restoreAllowedEnvs } = {}) => {
    return await postJson(`/admin/users/${userId}/unban`, {
      restoreRole,
      restoreAllowedEnvs,
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },

  // Invitations
  invitesPage: async ({ limit = 50, offset = 0 } = {}) => {
    return await getJson(withQuery("/admin/invites", { limit, offset }))
      .then(({ data }) => ({ invites: data?.invites || [], page: data?.page }))
      .catch((e) => {
        console.error(e);
        return { invites: [], page: null };
      });
  },
  invites: async () => {
    return await getJson("/admin/invites")
      .then(({ data }) => data?.invites || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  newInvite: async ({
    role = "default",
    workspaceIds = null,
    expiresInHours = 24,
  }) => {
    return await postJson("/admin/invite/new", {
      role,
      workspaceIds,
      expiresInHours,
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { invite: null, error: e.message };
      });
  },
  systemPreferences: async (labels = []) => {
    const query = labels.length ? `?labels=${labels.join(",")}` : "";
    return await getJson(`/admin/system-preferences-for${query}`)
      .then(({ data }) => data?.settings || {})
      .catch((e) => {
        console.error(e);
        return {};
      });
  },
  disableInvite: async (inviteId) => {
    return await deleteJson(`/admin/invite/${inviteId}`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },

  // Workspaces Mgmt
  workspacesPage: async ({ limit = 50, offset = 0 } = {}) => {
    return await getJson(withQuery("/admin/workspaces", { limit, offset }))
      .then(({ data }) => ({
        workspaces: data?.workspaces || [],
        page: data?.page,
      }))
      .catch((e) => {
        console.error(e);
        return { workspaces: [], page: null };
      });
  },
  workspaces: async () => {
    return await getJson("/admin/workspaces")
      .then(({ data }) => data?.workspaces || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  workspaceUsers: async (workspaceId) => {
    return await getJson(`/admin/workspaces/${workspaceId}/users`)
      .then(({ data }) => data?.users || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  newWorkspace: async (name) => {
    return await postJson("/admin/workspaces/new", { name })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { workspace: null, error: e.message });
      });
  },
  updateUsersInWorkspace: async (workspaceId, userIds = []) => {
    return await postJson(`/admin/workspaces/${workspaceId}/update-users`, {
      userIds,
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteWorkspace: async (workspaceId) => {
    return await deleteJson(`/admin/workspaces/${workspaceId}`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },

  // System Preferences
  /**
   * Fetches system preferences by fields
   * @param {string[]} labels - Array of labels for settings
   * @returns {Promise<{settings: Object, error: string}>} - System preferences object
   */
  systemPreferencesByFields: async (labels = []) => {
    return await getJson(
      `/admin/system-preferences-for?labels=${labels.join(",")}`
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  updateSystemPreferences: async (updates = {}) => {
    return await postJson("/admin/system-preferences", updates)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },

  // API Keys
  getApiKeys: async function () {
    return getJson("/admin/api-keys")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return {
          apiKeys: [],
          error: responseError(e, "Error fetching api keys."),
        };
      });
  },
  generateApiKey: async function (data = {}) {
    return postJson("/admin/generate-api-key", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return {
          apiKey: null,
          error: responseError(e, "Error generating api key."),
        };
      });
  },
  deleteApiKey: async function (apiKeyId = "") {
    return deleteJson(`/admin/delete-api-key/${apiKeyId}`)
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
};

export default Admin;
