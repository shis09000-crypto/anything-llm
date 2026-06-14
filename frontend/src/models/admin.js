import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

async function responseJson(res) {
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || res.statusText };
  }

  if (!res.ok) {
    return {
      success: false,
      error: data?.error || data?.message || res.statusText,
      ...data,
    };
  }
  return data;
}

const Admin = {
  // User Management
  users: async () => {
    return await fetch(`${API_BASE}/admin/users`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res?.users || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  newUser: async (data) => {
    return await fetch(`${API_BASE}/admin/users/new`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { user: null, error: e.message };
      });
  },
  updateUser: async (userId, data) => {
    return await fetch(`${API_BASE}/admin/user/${userId}`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  deleteUser: async (userId) => {
    return await Admin.deleteUserWithReauth(userId, {});
  },
  userDeletePreview: async (userId) => {
    return await fetch(`${API_BASE}/admin/users/${userId}/delete-preview`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then(responseJson)
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  deleteUserWithReauth: async (userId, { confirm = false, reauthToken } = {}) => {
    return await fetch(`${API_BASE}/admin/user/${userId}`, {
      method: "DELETE",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm, reauthToken }),
    })
      .then(responseJson)
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  banUser: async (userId, reason = "") => {
    return await fetch(`${API_BASE}/admin/users/${userId}/ban`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason }),
    })
      .then(responseJson)
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  unbanUser: async (userId, { restoreRole, restoreAllowedEnvs } = {}) => {
    return await fetch(`${API_BASE}/admin/users/${userId}/unban`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ restoreRole, restoreAllowedEnvs }),
    })
      .then(responseJson)
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Invitations
  invites: async () => {
    return await fetch(`${API_BASE}/admin/invites`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res?.invites || [])
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
    return await fetch(`${API_BASE}/admin/invite/new`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        role,
        workspaceIds,
        expiresInHours,
      }),
    })
      .then(responseJson)
      .catch((e) => {
        console.error(e);
        return { invite: null, error: e.message };
      });
  },
  systemPreferences: async (labels = []) => {
    const query = labels.length ? `?labels=${labels.join(",")}` : "";
    return await fetch(`${API_BASE}/admin/system-preferences-for${query}`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res?.settings || {})
      .catch((e) => {
        console.error(e);
        return {};
      });
  },
  disableInvite: async (inviteId) => {
    return await fetch(`${API_BASE}/admin/invite/${inviteId}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Workspaces Mgmt
  workspaces: async () => {
    return await fetch(`${API_BASE}/admin/workspaces`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res?.workspaces || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  workspaceUsers: async (workspaceId) => {
    return await fetch(`${API_BASE}/admin/workspaces/${workspaceId}/users`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res?.users || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  newWorkspace: async (name) => {
    return await fetch(`${API_BASE}/admin/workspaces/new`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ name }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { workspace: null, error: e.message };
      });
  },
  updateUsersInWorkspace: async (workspaceId, userIds = []) => {
    return await fetch(
      `${API_BASE}/admin/workspaces/${workspaceId}/update-users`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ userIds }),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  deleteWorkspace: async (workspaceId) => {
    return await fetch(`${API_BASE}/admin/workspaces/${workspaceId}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // System Preferences
  /**
   * Fetches system preferences by fields
   * @param {string[]} labels - Array of labels for settings
   * @returns {Promise<{settings: Object, error: string}>} - System preferences object
   */
  systemPreferencesByFields: async (labels = []) => {
    return await fetch(
      `${API_BASE}/admin/system-preferences-for?labels=${labels.join(",")}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  updateSystemPreferences: async (updates = {}) => {
    return await fetch(`${API_BASE}/admin/system-preferences`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(updates),
    })
      .then(responseJson)
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // API Keys
  getApiKeys: async function () {
    return fetch(`${API_BASE}/admin/api-keys`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(res.statusText || "Error fetching api keys.");
        }
        return res.json();
      })
      .catch((e) => {
        console.error(e);
        return { apiKeys: [], error: e.message };
      });
  },
  generateApiKey: async function (data = {}) {
    return fetch(`${API_BASE}/admin/generate-api-key`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(data),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(res.statusText || "Error generating api key.");
        }
        return res.json();
      })
      .catch((e) => {
        console.error(e);
        return { apiKey: null, error: e.message };
      });
  },
  deleteApiKey: async function (apiKeyId = "") {
    return fetch(`${API_BASE}/admin/delete-api-key/${apiKeyId}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.ok)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
};

export default Admin;
