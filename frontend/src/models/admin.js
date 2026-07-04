import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
  apiErrorRaw as rawBody,
} from "@/lib/communication/apiError";
import { adminSystemStateStore } from "@/utils/serverState/adminSystemStateStore";
import { sensitiveSessionCenter } from "@/utils/sensitive/sensitiveSessionCenter";

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

async function ensureAdminValue(cacheKey, fetcher, fallback, options = {}) {
  try {
    return await adminSystemStateStore.ensure(cacheKey, fetcher, {
      priority: options.priority || "P2",
      policy: options.policy || "background",
      surface: options.surface,
      scope: options.scope,
      ttlMs: options.ttlMs,
      meta: options.meta,
      label: options.label,
      dedupeKey: options.dedupeKey || `server-state:${cacheKey}`,
    });
  } catch (e) {
    console.error(e);
    return adminSystemStateStore.getOrFallback(cacheKey, fallback, {
      ttlMs: options.ttlMs,
    });
  }
}

const Admin = {
  // User Management
  usersPage: async ({ limit = 50, offset = 0 } = {}) => {
    const cacheKey = adminSystemStateStore.keys.adminUsersPage({
      limit,
      offset,
    });
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson(
          withQuery("/admin/users", { limit, offset }),
          {
            signal,
            task: false,
          }
        );
        const payload = { users: data?.users || [], page: data?.page };
        return payload;
      },
      { users: [], page: null },
      {
        surface: "admin-users",
        meta: { limit, offset },
        label: `admin:users:${limit}:${offset}`,
      }
    );
  },
  users: async () => {
    const cacheKey = adminSystemStateStore.keys.adminUsers;
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson("/admin/users", {
          signal,
          task: false,
        });
        return data?.users || [];
      },
      [],
      { surface: "admin-users", label: "admin:users" }
    );
  },
  newUser: async (data) => {
    return await postJson("/admin/users/new", data)
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminUsers();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { user: null, error: e.message });
      });
  },
  updateUser: async (userId, data) => {
    return await postJson(`/admin/user/${userId}`, data)
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminUsers();
        return data;
      })
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
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminUsers();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },
  banUser: async (userId, reason = "") => {
    return await postJson(`/admin/users/${userId}/ban`, { reason })
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminUsers();
        return data;
      })
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
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminUsers();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { success: false, error: e.message };
      });
  },

  // Invitations
  invitesPage: async ({ limit = 50, offset = 0 } = {}) => {
    const cacheKey = adminSystemStateStore.keys.adminInvitesPage({
      limit,
      offset,
    });
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson(
          withQuery("/admin/invites", { limit, offset }),
          { signal, task: false }
        );
        const payload = { invites: data?.invites || [], page: data?.page };
        return payload;
      },
      { invites: [], page: null },
      {
        surface: "admin-invites",
        meta: { limit, offset },
        label: `admin:invites:${limit}:${offset}`,
      }
    );
  },
  invites: async () => {
    const cacheKey = adminSystemStateStore.keys.adminInvites;
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson("/admin/invites", {
          signal,
          task: false,
        });
        return data?.invites || [];
      },
      [],
      { surface: "admin-invites", label: "admin:invites" }
    );
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
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminInvites();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawBody(e)
          ? responseJsonError(e)
          : { invite: null, error: e.message };
      });
  },
  systemPreferences: async (labels = []) => {
    const query = labels.length ? `?labels=${labels.join(",")}` : "";
    const cacheKey = adminSystemStateStore.keys.adminSystemPreferences(labels);
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson(
          `/admin/system-preferences-for${query}`,
          {
            signal,
            task: false,
          }
        );
        return data?.settings || {};
      },
      {},
      {
        surface: "admin-system-preferences",
        meta: { labels: labels.join(",") },
        label: `admin:system-preferences:${labels.join(",")}`,
      }
    );
  },
  disableInvite: async (inviteId) => {
    return await deleteJson(`/admin/invite/${inviteId}`)
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminInvites();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },

  // Workspaces Mgmt
  workspacesPage: async ({ limit = 50, offset = 0 } = {}) => {
    const cacheKey = adminSystemStateStore.keys.adminWorkspacesPage({
      limit,
      offset,
    });
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson(
          withQuery("/admin/workspaces", { limit, offset }),
          { signal, task: false }
        );
        const payload = {
          workspaces: data?.workspaces || [],
          page: data?.page,
        };
        return payload;
      },
      { workspaces: [], page: null },
      {
        surface: "admin-workspaces",
        meta: { limit, offset },
        label: `admin:workspaces:${limit}:${offset}`,
      }
    );
  },
  workspaces: async () => {
    const cacheKey = adminSystemStateStore.keys.adminWorkspaces;
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson("/admin/workspaces", {
          signal,
          task: false,
        });
        return data?.workspaces || [];
      },
      [],
      { surface: "admin-workspaces", label: "admin:workspaces" }
    );
  },
  workspaceUsers: async (workspaceId) => {
    const cacheKey =
      adminSystemStateStore.keys.adminWorkspaceUsers(workspaceId);
    return await ensureAdminValue(
      cacheKey,
      async ({ signal }) => {
        const { data } = await getJson(
          `/admin/workspaces/${workspaceId}/users`,
          {
            signal,
            task: false,
          }
        );
        return data?.users || [];
      },
      [],
      {
        surface: "admin-workspace-users",
        scope: { workspaceId },
        label: `admin:workspace-users:${workspaceId}`,
      }
    );
  },
  newWorkspace: async (name) => {
    return await postJson("/admin/workspaces/new", { name })
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminWorkspaces();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { workspace: null, error: e.message });
      });
  },
  updateUsersInWorkspace: async (workspaceId, userIds = []) => {
    return await postJson(`/admin/workspaces/${workspaceId}/update-users`, {
      userIds,
    })
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminWorkspaces();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteWorkspace: async (workspaceId) => {
    return await deleteJson(`/admin/workspaces/${workspaceId}`)
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminWorkspaces();
        return data;
      })
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
    const cacheKey = adminSystemStateStore.keys.adminSystemPreferences(labels);
    return await getJson(
      `/admin/system-preferences-for?labels=${labels.join(",")}`
    )
      .then(({ data }) => {
        adminSystemStateStore.set(cacheKey, data, {
          surface: "admin-system-preferences",
          meta: { labels: labels.join(",") },
        });
        return data;
      })
      .catch((e) => {
        console.error(e);
        return adminSystemStateStore.getOrFallback(cacheKey, null);
      });
  },
  updateSystemPreferences: async (updates = {}, options = {}) => {
    return await postJson("/admin/system-preferences", updates, {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "admin-system-preferences",
      task: options.task,
    })
      .then(({ data }) => {
        adminSystemStateStore.invalidateAdminSystemPreferences();
        return data;
      })
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
      .then(({ data }) => {
        if (data?.sensitiveSession) {
          sensitiveSessionCenter.store(data.sensitiveSession, {
            resourceType: "api_key",
            resourceId: data?.apiKey?.id || "generated",
          });
        }
        return data;
      })
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
